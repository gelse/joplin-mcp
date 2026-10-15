# Sync Behaviour

Reader: an operator responsible for data safety — when the container syncs, how conflicts and concurrent access are handled, and what protects your notes when sync goes wrong. (For the original issue threads behind the safety mechanisms, see the project issue tracker.)

## Sync modes

The entrypoint's bash scheduler is the sole sync mechanism; all `joplin sync` invocations run through it.

- **Initial sync** — runs once at container start, before the MCP server starts ([`entrypoint-combined.sh:751-755`](entrypoint-combined.sh:751)). On a destructive-signature detection the halt marker is written and the periodic loop never starts.
- **Periodic sync** — a `while true` loop sleeps `SYNC_INTERVAL_SECONDS` (default `300`) between iterations and checks the halt marker before each sync ([`entrypoint-combined.sh:1052-1062`](entrypoint-combined.sh:1052)).
- **Scheduled pickup** — there is no per-write sync: every create/update/delete/untag made through the MCP tools persists locally and reaches Joplin Server within one interval (≤ `SYNC_INTERVAL_SECONDS`).

## Conflict resolution

Conflicts resolve **remote-wins** — built-in Joplin CLI behaviour; local changes yield to the remote version, and conflicted copies are flagged in Joplin. The combined container does not log conflicts — its bash sync loop never inspects sync output for them. The legacy `CliExecutor.sync()` helper (stdio path, not wired in the combined container) logs `"Sync conflicts detected — remote version retained"` ([`src/cli-executor.ts:172-174`](src/cli-executor.ts:172)) and can count conflicted notes programmatically via `CliExecutor.checkConflicts()` ([`src/cli-executor.ts:198-202`](src/cli-executor.ts:198)).

## Serialization and the deletion circuit-breaker

Two safeguards wrap every sync:

- **flock serialization** — every `joplin sync` runs under `flock -w 120` on `.sync-flock` in the profile directory ([`entrypoint-combined.sh:755`](entrypoint-combined.sh:755)), preventing sync-vs-sync overlap (initial vs periodic vs shutdown). This does **not** cover Data-API-vs-sync contention — see below.
- **Deletion circuit-breaker** — before each sync the entrypoint counts notes and folders; after the sync it compares counts. If more than `SYNC_MAX_DELETE_COUNT` items vanished, the breaker trips and writes a halt marker ([`entrypoint-combined.sh:484-550`](entrypoint-combined.sh:484)).

`SYNC_MAX_DELETE_COUNT` semantics ([`entrypoint-combined.sh:494-497`](entrypoint-combined.sh:494), [`entrypoint-combined.sh:540-546`](entrypoint-combined.sh:540)):

- Default `100` (set in [`entrypoint-combined.sh:578`](entrypoint-combined.sh:578))
- `-1` disables the breaker entirely
- `0` trips on **any** deletion

A failed or suspicious item count (including a pre-count of 0, which could mask a full wipe) skips the check with a warning rather than tripping on bad data.

## SQLITE_BUSY and damage limitation

The Data API and `joplin sync` share one SQLite database. When the Data API holds the write lock, a concurrent sync can receive `SQLITE_BUSY: database is locked`; the CLI then treats the database version as `null` and runs destructive schema migrations from version 0.

The container **cannot prevent the first occurrence** of this race: the Data API never takes the CLI's flock, and `database.busyTimeout` is not supported by the pinned Joplin CLI 3.7.1 — `joplin config database.busyTimeout` fails with "Unknown key", and the entrypoint logs this explicitly at startup ([`entrypoint-combined.sh:611-615`](entrypoint-combined.sh:611)). What the container provides instead is **damage limitation**:

1. **Detection + halt marker** — after every sync (initial, periodic, and shutdown final), the log files are scanned for the dangerous pattern `SQLITE_BUSY|database is locked|Upgrading database from version 0|Current database version.*null` ([`entrypoint-combined.sh:190`](entrypoint-combined.sh:190)). A match writes a persistent halt marker (`.sync-halt` in the profile directory, [`entrypoint-combined.sh:32`](entrypoint-combined.sh:32)) that permanently refuses further syncs.
2. **Deletion circuit-breaker** — `SYNC_MAX_DELETE_COUNT` (semantics above) trips the same halt marker when a sync deletes too many items.
3. **flock serialization** — prevents sync-vs-sync overlap, removing one contention source (but not the Data API race).

## Halt markers and recovery

Every halt site writes `.sync-halt` with a bracketed tag naming the cause: `[SYNC_ABORT]`/`[CIRCUIT_BREAKER]` for destructive-deletion signatures, `[E2EE_NO_MASTER_KEY]`/`[E2EE_DECRYPT_FAIL]`/`[E2EE_DECRYPT_INCOMPLETE]` for E2EE failures. The refusal path reads the tag back and routes the operator to the matching cause; an unknown or unreadable marker falls back to generic wording, never to a wrong diagnosis ([`entrypoint-combined.sh:95-118`](entrypoint-combined.sh:95)).

Recovery: investigate the logged cause, then remove the marker to re-enable syncing:

```bash
docker exec joplin-mcp rm /home/joplin/.config/joplin/.sync-halt
```

Until the marker is removed, every sync attempt (and the shutdown final sync) is refused with an error naming the marker and tag.

## Joplin Server minimum client version

Joplin Server enforces a minimum client version for sync compatibility. The pinned CLI (`joplin@3.7.1` in [`Dockerfile.combined:44`](Dockerfile.combined:44)) is therefore a compatibility constraint: upgrading Joplin Server may require a matching image upgrade if the server's minimum client version exceeds the pinned CLI. A mismatch causes sync to silently fail — the CLI still exits 0.

## Initial sync throughput

Initial sync is governed by the pinned Joplin CLI's per-item sync algorithm (`joplin@3.7.1`). The historically observed ~12 items/min figure comes from the pre-0.2.0 two-container setup, where Data API contention during sync was a known contributing factor; that contention was removed in the 0.2.0 single-container architecture, and actual post-0.2.0 throughput is unmeasured. The investigation verdict is recorded in [`CHANGELOG.md`](CHANGELOG.md), and throughput can be measured against a live server with [`scripts/measure-initial-sync.sh`](scripts/measure-initial-sync.sh).

The container healthcheck's `--start-period=120s` ([`Dockerfile.combined:86`](Dockerfile.combined:86)) budgets for this window: a fresh container with a large library may not expose the MCP `/health` endpoint until the initial sync completes (see [`docs/architecture.md#healthcheck`](docs/architecture.md#healthcheck)).

## Post-sync decrypt in the periodic loop

When `JOPLIN_MASTER_PASSWORD` is set, every periodic-sync cycle runs a post-sync `joplin e2ee decrypt --force` (master-key preflight, 4 attempts, 5 s backoff, SQLite verification) after the sync, regardless of the sync's exit code ([`entrypoint-combined.sh:370-481`](entrypoint-combined.sh:370), [`entrypoint-combined.sh:1101-1113`](entrypoint-combined.sh:1101)). This pass deliberately **never halts**: a transient decrypt failure is logged as FAIL, and the next cycle retries. The boot-time fail-closed gates that do halt are described in [`docs/e2ee.md`](docs/e2ee.md).

## The `sync` MCP tool

The MCP `sync` tool does not trigger a sync — it reports that syncing is handled by the entrypoint's scheduler. See [`docs/tools.md#the-sync-tool`](docs/tools.md#the-sync-tool).

## Where to read next

- Container topology and startup/shutdown ordering: [`docs/architecture.md`](docs/architecture.md)
- E2EE decrypt pipelines and their halt markers: [`docs/e2ee.md`](docs/e2ee.md)
- Credential handling and token rotation: [`docs/security.md`](docs/security.md)
- Symptom-by-symptom diagnostics: [`docs/troubleshooting.md`](docs/troubleshooting.md)
