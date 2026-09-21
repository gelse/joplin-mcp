# Sync Failure Detection — Solution Plan

Date: 2026-09-13
Origin: [Issue #21](https://github.com/gelse/joplin-mcp/issues/21) — "Pinned JOPLIN_CLI_VERSION=3.6.2 is rejected by current Joplin Server (needs 3.7.0+) — silent total sync outage"
Status: design agreed with maintainer; **no issue created yet**

## The problem in one paragraph

`joplin sync` can fail totally while exiting 0 and logging `SYNC_PASS`. The sync loop in [`entrypoint-combined.sh`](../entrypoint-combined.sh:324) already detects error patterns in `log.txt` via [`check_sync_errors()`](../entrypoint-combined.sh:69) — but the result goes nowhere: it is written to a log line and forgotten. The MCP server keeps serving reads from an increasingly stale local database, writes pile up locally forever, and nothing (healthcheck, `/health`, tool responses) tells anyone. This class of failure re-arms every time Joplin Server raises its minimum client version, and per the issue comments it is inherently hard: sync is asynchronous, the CLI is a black box out of our control, and "failure" ranges from a blip (network) to permanent (version floor).

## Decisions (from maintainer grilling)

| # | Question | Decision |
|---|----------|----------|
| 1 | Writes when sync is broken? | **Succeed, but every write response carries a sync-health warning** (e.g. `SYNC_DEGRADED: last successful sync 3h ago — changes are local-only until sync recovers`) |
| 2 | Docker healthcheck? | **Default: healthcheck keeps passing; `/health` returns detailed sync status.** Opt-in env `SYNC_ERROR_IS_CONTAINER_HEALTH=1` makes the healthcheck exit 1 (unhealthy) when sync is `broken` |
| 3 | Email reports? | **Out of scope** for this iteration; possible future issue |
| 4 | Error classification? | **Yes, plus liveness proof**: classify known patterns (version-mismatch, auth/encryption, network, unknown) *and* detect silent no-op syncs (exit 0, zero remote operations, while writes are pending) to catch future unknown silent classes |
| 5 | State sharing between bash loop and Node MCP? | **Ephemeral state file** at an in-container path. A container restart resets sync health — acceptable, because the startup initial sync re-establishes state |
| 6 | Startup version check? | **Fail fast**: if the initial sync detects a version-mismatch rejection, exit 1 with a clear error instead of continuing silently |
| 7 | State definitions? | `degraded` = at least one failure but below threshold; `broken` = N consecutive failures (default 3, env-configurable). No time-based staleness rule — interval-agnostic |

## Design

### 1. Sync state file (single source of truth)

The bash sync loop writes `/var/run/joplin-mcp/sync-state.json` atomically (write to `sync-state.json.tmp`, then `mv`) after every sync attempt:

```json
{
  "status": "healthy | degraded | broken",
  "lastSuccessAt": "2026-09-13T16:00:00Z | null",
  "lastAttemptAt": "2026-09-13T16:05:00Z",
  "consecutiveFailures": 0,
  "errorClass": "version-mismatch | auth-encryption | network | silent-noop | unknown | null",
  "errorMessage": "In order to synchronise, please upgrade your application to version 3.7.0+",
  "noopSyncsWithPendingWrites": 0
}
```

State transitions (evaluated after each sync attempt):

- Sync exit ≠ 0 **or** `check_sync_errors` detects patterns → failure. Increment `consecutiveFailures`. `status = degraded` when below threshold, `broken` at ≥ `SYNC_FAILURE_THRESHOLD`.
- Clean pass → reset `consecutiveFailures` and `noopSyncsWithPendingWrites` to 0, `status = healthy`, update `lastSuccessAt`.
- Liveness-proof trip (see §3) → `broken` with `errorClass = silent-noop`.

New environment variables (defaults shown):

| Variable | Default | Meaning |
|----------|---------|---------|
| `SYNC_FAILURE_THRESHOLD` | `3` | Consecutive failures before `broken` |
| `SYNC_NOOP_THRESHOLD` | `3` | Consecutive no-op syncs with pending writes before `broken` |
| `SYNC_ERROR_IS_CONTAINER_HEALTH` | `false` | When truthy, healthcheck fails on `broken` |
| `SYNC_STATE_FILE` | `/var/run/joplin-mcp/sync-state.json` | Ephemeral state path (also used for the write marker) |

A missing or unparsable state file is treated as `status: "unknown"` — never worse than that; the MCP must not block writes because of its own bookkeeping.

### 2. Error classification (bash, extends `check_sync_errors`)

Refactor `check_sync_errors` from a boolean grep into a classifier that returns both a verdict and a class, using the same sources it already reads (`log.txt` new-lines via the existing offset mechanism, `sync-stdout.log`, `sync-stderr.log`):

| Class | Detection |
|-------|-----------|
| `version-mismatch` | `please upgrade your application` in the sync window (the exact string from issue #21) |
| `auth-encryption` | `Master key is not loaded`, `Could not encrypt item` (existing patterns) |
| `network` | exit ≠ 0 / timeout **and** the startup-style `curl` probe of `JOPLIN_SERVER_URL/api/ping` also fails right after the sync attempt |
| `unknown` | any other `[error]` pattern or non-zero exit with a reachable server |
| `silent-noop` | see §3 — not a pattern; a behavioural verdict |

The ordering matters: probe network last, only when other classes didn't match, so a version rejection while the server is reachable is never mislabelled `network`.

### 3. Liveness proof (catching unknown silent classes)

Pattern matching alone cannot catch the *next* silent failure we haven't seen yet. Complement it with a behavioural check:

1. The MCP Node process touches a write marker (`/var/run/joplin-mcp/last-write-at`, an mtime) after every successful write tool call (create/update/delete note, folder, tag — anything mutating).
2. The sync loop already captures the `log.txt` offset before each sync. After a clean-exit sync, it greps the window for `createRemote|updateRemote|deleteRemote`.
3. If the write marker is newer than `lastSuccessAt` **and** the sync window contained zero remote-operation lines → count a no-op sync with pending writes. At ≥ `SYNC_NOOP_THRESHOLD` consecutive such syncs → `broken`, `errorClass = silent-noop`.

Rationale: with periodic-only sync in the combined container, any accepted-but-unsynced write must eventually appear as a remote operation in `log.txt`. A healthy CLI that exits 0 while never moving items is by definition not syncing.

Known limitation (accepted): the marker does not survive restarts, matching the ephemeral-state decision. There is also no false positive from a write-triggered immediate sync flushing the marker — the combined container has no write-triggered sync; the periodic loop is the only sync path.

### 4. Startup fail-fast (issue #21 suggestion 3)

The entrypoint already runs an initial sync before starting the loop. Change its handling:

- **Version-mismatch detected in the initial sync window → `exit 1`** with a loud, actionable message: the server requires a newer client; upgrade the image (or rebuild with `--build-arg JOPLIN_CLI_VERSION=<n>`). This turns the week-long silent outage into a 60-second startup failure.
- Additionally, during the existing connectivity probe, compare `joplin version` (local CLI) against the version reported by `${JOPLIN_SERVER_URL}/api/ping` and log a prominent `WARN` when the client is older than the server — an early hint, not a hard gate (the server's true minimum is only revealed by an actual sync attempt).
- All other initial-sync failure classes keep today's behaviour (log, continue) — a temporarily unreachable server at boot must not become a crash loop.

### 5. `/health` endpoint enrichment

[`startMCPServer()` in `src/mcp/server.ts`](../src/mcp/server.ts) currently answers `{status: "ok"}`. Extend it to read `SYNC_STATE_FILE` (by path from env; absent in the native/two-container path → omit the sync block entirely) and answer:

```json
{
  "status": "ok",
  "sync": {
    "status": "healthy | degraded | broken | unknown",
    "lastSuccessAt": "…",
    "lastAttemptAt": "…",
    "consecutiveFailures": 0,
    "errorClass": null,
    "errorMessage": null
  }
}
```

The HTTP status stays 200 as long as the MCP itself works — orchestrators decide what to do with a degraded sync. Read the file per request (it is tiny and on tmpfs); no watcher needed.

### 6. Write-tool warnings (decision 1)

Every mutating tool response in [`src/mcp/tools.ts`](../src/mcp/tools.ts) gains a `syncWarning` field, populated from the same state file when `status` is `degraded` or `broken`:

- `broken`: `SYNC_BROKEN: sync has failed N consecutive times (class: version-mismatch) — changes are local-only until sync recovers; last successful sync: 2026-09-13T12:00:00Z`
- `degraded`: `SYNC_DEGRADED: last sync attempt failed (class: network) — changes may be local-only until sync recovers`

Omitted entirely (not `null`) when healthy/unknown, so successful normal operation looks exactly as before. Reads never warn.

### 7. Healthcheck (decision 2)

Replace the inline `HEALTHCHECK CMD` in [`Dockerfile.combined`](../Dockerfile.combined:86) with a small `healthcheck.sh` copied into the image:

1. `curl -f 127.0.0.1:41184/ping` and `curl -f 127.0.0.1:3000/health` (unchanged baseline).
2. If `SYNC_ERROR_IS_CONTAINER_HEALTH` is truthy: parse the sync block from `/health` and exit 1 when `sync.status == "broken"`.

Default behaviour is unchanged — no surprise `unhealthy` containers for people who don't opt in.

### 8. `sync` MCP tool

In the combined container the [`sync` tool](../src/mcp/tools.ts:228) currently returns a static string. Change it to return the sync state from the state file (same shape as the `/health` sync block) plus a hint that sync runs on a schedule; it still never triggers a sync itself (the bash loop owns syncing).

## What does not change

- The bash periodic sync loop stays the sole sync authority; no resurrection of the TypeScript [`SyncManager`](../src/sync-manager.ts) in the combined container.
- No restart-on-broken-sync behaviour, no email reports, no time-based staleness rules.
- Two-container / native deployments without the state file: `/health`, tools, and healthcheck behave exactly as today.

## Test strategy

- **Bash unit tests**: extend [`tests/test-check-sync-errors.sh`](../tests/test-check-sync-errors.sh) — classification per class, state-file transitions (degraded → broken at threshold, recovery reset), no-op detection with/without pending writes, atomic-write behaviour. Follow the existing pattern of copying the function verbatim.
- **Node unit tests**: `/health` with healthy/degraded/broken/missing state file; `syncWarning` on write tools; `sync` tool output.
- **Container tests** ([`tests/container/`](../tests/container/)): inject a crafted state file via the existing test harness, assert `/health` and a write-tool response carry the degraded/broken signal; assert default healthcheck script passes while `SYNC_ERROR_IS_CONTAINER_HEALTH=1` + broken state fails it.
- **Startup fail-fast**: simulate the `please upgrade your application` pattern in a fake `log.txt` for the initial sync and assert the container exits non-zero with the upgrade message (extend the pattern used by [`tests/test-sync-failure-diagnostics.sh`](../tests/test-sync-failure-diagnostics.sh)).

## Implementation order (one PR or small stack)

1. Bash: classifier refactor + state-file writer + no-op detection + startup fail-fast.
2. Node: state-file reader, `/health` sync block, write-tool warnings, `sync` tool.
3. Dockerfile: `healthcheck.sh` + `SYNC_ERROR_IS_CONTAINER_HEALTH` wiring.
4. Tests + README/PROMPT.md env-var documentation (tool count and docs must stay accurate).
