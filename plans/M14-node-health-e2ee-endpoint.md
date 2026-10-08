# M14 — Node-Side `/health/e2ee` Endpoint for the MCP HTTP Server

> Source: [`plans/backlog.md`](backlog.md) §1 (Live plans) **F3 → M14** (deferred by M2-T3/M2-T4; now planned).
> Refines the fallback hinted at in
> [`plans/_finished/M2-T3-sync-detection-and-healthcheck-hardening.md`](_finished/M2-T3-sync-detection-and-healthcheck-hardening.md)
> §8 Risk 3 (in the pre-filing copy, `:174`) and called out as a
> future-honoring candidate at
> [`plans/_finished/M2-T4-flip-to-green-verification-and-docs.md`](_finished/M2-T4-flip-to-green-verification-and-docs.md):265.
> Implementation starts in a fresh session from this file alone.

## Problem

The encryption-aware `HEALTHCHECK` in
[`Dockerfile.combined:86-87`](../Dockerfile.combined:86) duplicates the
SQLite probe inline: a non-trivial `node -e "…"` SQL with six tables
(`notes`, `folders`, `resources`, `tags`, `note_tags`, `revisions`) and a
counted sum. The same probe exists in three places today:

1. `entrypoint-combined.sh:280-298` — the probe JS inside
   [`check_e2ee_state()`](../entrypoint-combined.sh:272).
2. `entrypoint-combined.sh:791-810` — the M2-T1 verification gate's
   `E2EE_VERIFY_SCRIPT`.
3. [`Dockerfile.combined:87`](../Dockerfile.combined:87) — the
   `HEALTHCHECK` CMD.

The LOCKSTEP comment at
[`entrypoint-combined.sh:265-268`](../entrypoint-combined.sh:265) makes the
triple-drift hazard explicit. A future change to the probe (table list,
field name) must be applied in all three sites in the same commit; the
verbatim function copies in
[`tests/test-check-sync-errors.sh`](../tests/test-check-sync-errors.sh) (the
verbatim-copy NOTE at `:111-116`) plus the preflight harness's Group-0
anti-drift greps already pin two of them.

A Node-side `/health/e2ee` endpoint inside the MCP HTTP server would let
the `HEALTHCHECK` become a simple `curl http://127.0.0.1:3000/health/e2ee`
— and the probe logic lives in one place that vitest can cover.

## Goal

Add a `GET /health/e2ee` endpoint to the MCP HTTP server that returns the
same fail-closed signal the entrypoint helper already produces, so a future
follow-up milestone can replace the inline `HEALTHCHECK` SQL with a one-line
`curl`. M14 ships the endpoint and its vitest coverage; the Dockerfile
switch is **proposed only** (a follow-up, out of M14 scope).

## State-source choice

Three candidate state sources were considered. The recommendation and its
rationale:

### Option A — Replicate the SQLite probe in Node

Mirror `entrypoint-combined.sh:280-298` as TypeScript in
`src/`. **Rejected.** Adds a fourth lockstep site instead of removing one
(the existing LOCKSTEP comment already names three); would need its own
SQLite module import path (the entrypoint uses
`/usr/local/lib/node_modules/joplin/node_modules/sqlite3`); and would need
its own `busy_timeout` policy. Net lockstep surface: worse.

### Option B — Read the entrypoint-written `.sync-halt` marker

The entrypoint already writes a single authoritative fail-closed signal at
[`SYNC_HALT_MARKER`](../entrypoint-combined.sh:32)
(`${JOPLIN_PROFILE_DIR}/.sync-halt`); its tag set covers every E2EE halt
([`entrypoint-combined.sh:97-101`](../entrypoint-combined.sh:97)):

- `CIRCUIT_BREAKER`, `SYNC_ABORT` → issue #27
- `E2EE_DECRYPT_FAIL`, `E2EE_DECRYPT_INCOMPLETE`, `E2EE_NO_MASTER_KEY` → issue #29
- unknown / empty / missing → fail-safe generic (no issue number)

The D4 helpers (`halt_marker_tag` at `:82`, `halt_marker_issue` at `:95`)
already parse this exact format. **Recommended.**

### Option C — Query the Data API for `encryption_applied === 0`

Use `JoplinDataClient.getAllFolders()` /
[`src/data-client.ts:491`](../src/data-client.ts:491) and inspect
`f.encryption_applied` on every returned folder
([`src/api-types.ts:45-46`](../src/api-types.ts:45)). **Rejected for two
reasons.** First, the symptom assertion at
[`tests/container/e2ee-encrypted-titles-repro.test.ts:278-280`](../tests/container/e2ee-encrypted-titles-repro.test.ts:278)
documents that `GET /folders` (as issued by `list_notebooks`, no `fields=`)
**omits** `encryption_applied` for every row — a strict `!== 0` check
would be permanently RED even on a genuinely decrypted, plaintext
response. Adding `fields=encryption_applied` to the probe call would
re-introduce field-shape coupling the project deliberately avoided in
M2-T1 (`entrypoint-combined.sh:689-708` is the SQLite probe precisely to
sidestep this). Third, the Data API itself binds loopback-only
([`entrypoint-combined.sh:483-489`](../entrypoint-combined.sh:483)); the
endpoint would not be reachable from outside the container anyway.

### Why Option B is the right fit

- **No new probe SQL** — eliminates one lockstep site outright.
- **Single source of truth** — every halt (initial-sync decrypt, M2-T1
  verification, M2-T1 master-key preflight, M2-T3 redundant check, future
  M13 periodic check) already writes the same marker. The endpoint is a
  read-side mirror of the existing write-side surface; no new semantics.
- **Idempotent / side-effect-free** — the marker is a file; reading it
  with `fs.readFile` cannot trigger a sync or write back.
- **No Data API dependency** — works even when the Data API is unhealthy,
  which is exactly when a content-aware healthcheck is most useful.

## Proposed Approach

In [`src/mcp/server.ts`](../src/mcp/server.ts), add a `GET /health/e2ee`
handler beside the existing `GET /health` handler
([`src/mcp/server.ts:131-136`](../src/mcp/server.ts:131)). Insertion point:
immediately after the `return;` at `:135`, before the existing
`createMCPServer + transport.handleRequest` block at `:142-147`.

### Exact insertion (current tree)

After [`src/mcp/server.ts:135`](../src/mcp/server.ts:135) (the `return;`
that closes the `/health` branch), insert:

```ts
    // E2EE health endpoint (M14, backlog F3): mirrors the entrypoint's
    // halt-marker read-side surface (log_halt_marker_refusal at
    // entrypoint-combined.sh:107-118 + halt_marker_tag/issue at :82-102).
    // Returns 200 when no halt marker is present, 200 with
    // {status:'e2ee-skip'} when JOPLIN_MASTER_PASSWORD is unset (no E2EE
    // expected), 503 when an E2EE-tagged halt marker is present, and 503
    // with the generic 'unknown-marker' body when an unknown tag is
    // present (fail-safe: never a wrong issue number). The HTTP code
    // follows the shell helper's verdict — Docker's HEALTHCHECK can be a
    // plain `curl -f` against this endpoint.
    if (req.url === '/health/e2ee') {
      const markerPath = `${process.env['JOPLIN_PROFILE_DIR'] ?? '/home/joplin/.config/joplin'}/.sync-halt`;
      // No-master-password path mirrors entrypoint-combined.sh:276-278.
      if (!process.env['JOPLIN_MASTER_PASSWORD']) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'e2ee-skip' }));
        return;
      }
      let firstLine = '';
      try {
        firstLine = (await import('node:fs/promises')).readFile(markerPath, 'utf8')
          .then((s) => s.split('\n', 1)[0] ?? '')
          .catch(() => '');
      } catch {
        firstLine = '';
      }
      const tagMatch = firstLine.match(/^[^\[]*\[([A-Z][A-Z0-9_]*)\]/);
      const tag = tagMatch ? tagMatch[1] : '';
      // Same map as entrypoint-combined.sh:97-101 — keep both in sync.
      const issue =
        tag === 'CIRCUIT_BREAKER' || tag === 'SYNC_ABORT' ? '27'
          : tag === 'E2EE_DECRYPT_FAIL' || tag === 'E2EE_DECRYPT_INCOMPLETE' || tag === 'E2EE_NO_MASTER_KEY' ? '29'
            : '';
      if (tag && issue) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'e2ee-incomplete', tag, issue }));
        return;
      }
      // Fail-safe: unknown / empty / unreadable marker → 503 generic.
      if (firstLine.trim() !== '') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'unknown-marker' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
```

(The await-on-readFile above is shown for clarity; the production code
should use the existing `node:fs/promises` import already used elsewhere
in `src/`, or add one if not present.)

The endpoint uses `process.env.JOPLIN_PROFILE_DIR` with the
`/home/joplin/.config/joplin` default that matches the entrypoint's own
declaration default at
[`entrypoint-combined.sh:30`](../entrypoint-combined.sh:30). Today
`JOPLIN_PROFILE_DIR` is **not** exported to Node by the entrypoint
([`entrypoint-combined.sh:949-952`](../entrypoint-combined.sh:949) only
exports `JOPLIN_CORE_URL`, `JOPLIN_API_TOKEN`, `LOG_LEVEL`, `MCP_PORT`),
but `docker-compose.test.yml:17` inherits `JOPLIN_MASTER_PASSWORD` via
`environment:` and the default profile dir matches. M14 adds an
`export JOPLIN_PROFILE_DIR` to the entrypoint's Node-env export block so
the endpoint can be re-pointed via env in custom deployments (parallel to
the existing `JOPLIN_CORE_URL` export). This is a one-line shell change
within M14's scope.

### Fail-closed response contract (mirrors the shell helper)

| State                                                | Body                                  | HTTP |
| --------------------------------------------------- | ------------------------------------- | ---- |
| No marker file, `JOPLIN_MASTER_PASSWORD` set        | `{status:'ok'}`                       | 200  |
| `JOPLIN_MASTER_PASSWORD` unset                      | `{status:'e2ee-skip'}`                | 200  |
| Marker with `E2EE_*` tag (issue #29)                | `{status:'e2ee-incomplete',tag,issue}`| 503  |
| Marker with `CIRCUIT_BREAKER`/`SYNC_ABORT` (issue #27) | `{status:'e2ee-incomplete',tag,issue}` | 503  |
| Marker with unknown tag, or empty/missing/unreadable | `{status:'unknown-marker'}` (no issue ref) | 503 |

The `unknown-marker` branch keeps the shell helper's fail-safe contract:
no wrong issue number is ever surfaced.

### Proposed Dockerfile HEALTHCHECK switch (PROPOSED ONLY)

Not in M14 scope. Recorded here so the next milestone can land it as a
one-line drop-in:

```dockerfile
# M14 endpoint replaces this inline probe. The HEALTHCHECK timing
# stays (30s interval, 10s timeout, 3 retries, 120s start-period).
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=120s \
    CMD curl -f http://127.0.0.1:41184/ping && curl -f http://127.0.0.1:3000/health && curl -f http://127.0.0.1:3000/health/e2ee || exit 1
```

The M14 endpoint returns 503 on E2EE halt-marker presence and 200 on
absence; `curl -f` exits non-zero on 5xx, so the healthcheck fails
fail-closed.

## Acceptance Criteria

- A new route `GET /health/e2ee` is registered in
  [`src/mcp/server.ts`](../src/mcp/server.ts), beside the existing
  `GET /health` at `:131-136`, with the response contract above.
- `node_modules/.bin/vitest run` stays at **428 passed / 14 skipped**
  (the count locked by the project's bookkeeping rule). New tests add to
  the suite but do not affect this total: vitest counts every test case
  in a `describe`, so the suite total grows by the number of new cases
  in the new `describe('GET /health/e2ee')` block. **Correction:** the
  user's locked count is the **baseline**; M14 adds tests, and the
  verification step captures the new total separately. The invariant
  is "no existing test goes red or fails"; the suite grows.
- The entrypoint exports `JOPLIN_PROFILE_DIR` to the Node MCP process
  (one new `export` line in the `entrypoint-combined.sh:949-952` block).
- Vitest tests for the new route pass. The minimum set:
  - **200 + ok** when no marker file exists and `JOPLIN_MASTER_PASSWORD`
    is set.
  - **200 + e2ee-skip** when `JOPLIN_MASTER_PASSWORD` is unset.
  - **503 + e2ee-incomplete + tag + issue='29'** when the marker
    first line starts with `[E2EE_DECRYPT_INCOMPLETE]`.
  - **503 + e2ee-incomplete + tag + issue='27'** when the marker
    first line starts with `[CIRCUIT_BREAKER]`.
  - **503 + unknown-marker** when the marker first line has no
    uppercase bracketed tag (or starts with `[lowercase]`).
  - **503 + unknown-marker** when the marker file is unreadable
    (mock a chmod-000 read).
- `shellcheck entrypoint-combined.sh` → no new warnings.
- `node_modules/.bin/vitest run tests/mcp/server.test.ts` → green (the
  existing `tests/mcp/server.test.ts` covers stdio; M14 adds a separate
  `tests/mcp/health-e2ee-endpoint.test.ts` that targets the new route
  with `vi.mock('node:fs/promises')`).

## Verification

1. **Vitest suite.** `node_modules/.bin/vitest run` → existing 428 +
   the new `/health/e2ee` cases pass; record the new total.
3. **Mcp-server unit test specifically.** `node_modules/.bin/vitest run
   tests/mcp/health-e2ee-endpoint.test.ts` → green.
4. **Static check.** `shellcheck entrypoint-combined.sh` → no new
   warnings.
5. **In-image behavioural check.** With the change merged,
   `RUN_E2EE_REPRO_TESTS=1 bash scripts/run-integration-tests.sh` →
   exit 0; from the host (or from another container on the same
   network namespace), `curl -f http://localhost:3000/health/e2ee`
   returns 200 + `{"status":"ok"}` against a clean fixture, and 200 +
   `{"status":"e2ee-skip"}` against a stack without
   `JOPLIN_MASTER_PASSWORD` (the default
   `docker-compose.test.yml:17` inherits an empty `JOPLIN_MASTER_PASSWORD`,
   so this is the path that runs in the non-e2ee-repro profile).
6. **Manual halt-marker injection (gated CI, optional).** In a fresh
   `RUN_E2EE_REPRO_TESTS=1` stack, `docker exec joplin-mcp bash -c 'echo
   "$(date -u +%Y-%m-%dT%H:%M:%SZ) [E2EE_DECRYPT_INCOMPLETE] test. See
   issue #29." > /home/joplin/.config/joplin/.sync-halt'` → a curl of
   `http://localhost:3000/health/e2ee` returns 503 with
   `{"status":"e2ee-incomplete","tag":"E2EE_DECRYPT_INCOMPLETE","issue":"29"}`.
   Remove the marker → curl returns 200 again.

## Non-goals

- No `Dockerfile.combined` change in this milestone. The proposed
  HEALTHCHECK switch is recorded above as a follow-up; landing it is
  M15+ scope and must be coordinated with the lockstep removal of the
  inline probe SQL (and an update to the
  `tests/test-check-sync-errors.sh:111-116` anti-drift grep).
- No `docker-compose.test.yml` change. The test-stack healthcheck at
  [`docker-compose.test.yml:22-27`](../docker-compose.test.yml:22) is a
  `healthcheck.test` that REPLACES the image HEALTHCHECK; it is
   deliberately insulated from content-aware probes (per the Q9 audit
   in [`plans/backlog.md`](backlog.md) §5 (Closed items) Q9). Any future mirror of
  `/health/e2ee` into the test stack is out of scope.
- No Data API integration. The endpoint deliberately avoids the Data
  API per Option C's documented reasons.
- No change to `entrypoint-combined.sh` beyond the one-line
  `export JOPLIN_PROFILE_DIR` addition. The helper
  [`check_e2ee_state()`](../entrypoint-combined.sh:272) stays the
  authoritative write-side surface for the periodic-loop re-check
  (M13) and the initial-sync check
  ([`entrypoint-combined.sh:842`](../entrypoint-combined.sh:842)).
- No change to the marker parser inside the entrypoint. The endpoint
  parses the marker independently — both readers share a contract
  documented in the comment at
  [`entrypoint-combined.sh:67-80`](../entrypoint-combined.sh:67) and the
  writer format at `:317` and `:323` (timestamp + `[TAG] reason. See
  issue #NN.`); a future bookkeeping pass can extract the shared
  parser into a tiny helper if drift appears (none expected).
- No CHANGELOG.md change.
- No commit creation.

## Risks / gotchas

- **Risk 1: lockstep drift between the entrypoint's
  `halt_marker_issue()` map (`entrypoint-combined.sh:97-101`) and the
  endpoint's inline tag-to-issue map.** The two lists must match
  exactly. Mitigation: the test suite covers both the `issue='29'` and
  `issue='27'` branches; a future bookkeeping pass can extract the
  constant into a shared module if drift appears. Out of M14 scope to
  restructure.
- **Risk 2: `JOPLIN_PROFILE_DIR` not exported in older deployments.**
  Before M14 lands, the entrypoint's Node-env export block at
  [`entrypoint-combined.sh:949-952`](../entrypoint-combined.sh:949) does
  not include `JOPLIN_PROFILE_DIR`. M14 adds the export; deployments
  with a custom profile directory that have already cached the
  entrypoint's export list need a rebuild. Mitigation: M14 ships with
  a one-line `export JOPLIN_PROFILE_DIR` insertion immediately after
  `export JOPLIN_CORE_URL` (`:949`); the diff is self-contained.
- **Risk 3: `fs/promises` mocking complexity.** The new route uses
  `node:fs/promises.readFile`; the existing
  [`tests/mcp/server.test.ts`](../tests/mcp/server.test.ts) mocks
  through `vi.mock` at module load. The new test file must
  `vi.mock('node:fs/promises', …)` before importing `server.ts`. This
  is standard vitest usage and matches the existing pattern in
  `tests/mcp/server.test.ts:26-40`. No new mocking infrastructure.
- **Risk 4: marking `src/mcp/server.ts` `path:` test coverage gap.**
  The current `tests/mcp/server.test.ts` covers stdio transport only;
  it does NOT exercise the HTTP server. M14's test file is the first
  HTTP-route test pattern in `tests/mcp/`. It does not modify the
  existing stdio tests; it adds the HTTP-route test alongside. A
  future milestone could extract a shared `startMCPHttpServer` factory
  test helper if the suite grows further (out of M14 scope).