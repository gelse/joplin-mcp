# M1 — SQLite Busy Reproduction Integration Test

## Goal

Create a container integration test that deterministically reproduces the
SQLITE_BUSY data-destruction scenario described in GitHub issue #27. The test
holds the SQLite write lock (via a second Joplin CLI process), triggers
`joplin sync`, and asserts the destructive log signatures that indicate the
CLI concluded version was `null` and ran schema migrations from version 0.
**This test must FAIL against the current container code** — proving the bug
exists — and is designed to flip to PASS once M2's fixes land.

## Background

GitHub issue #27 reports that when the Joplin Data API holds the SQLite write
lock on `database.sqlite`, a concurrent `joplin sync` call receives
`SQLITE_BUSY: database is locked` when reading the `version` table. The
Joplin CLI (3.7.1, upstream `JoplinDatabase.js`) then treats the version as
`null`, concludes the database is brand-new, and re-runs schema migrations
from version 0 — destroying all data. This has been verified in production:
profiles destroyed, notes silently zeroed. The combined container runs the
Data API and `joplin sync` concurrently against the same profile, making this
contention trivially reachable.

## Prerequisites / Dependencies

- Docker + docker compose available on the host (same as existing integration tests).
- Test infrastructure already in place:
  [`docker-compose.test.yml`](../docker-compose.test.yml),
  [`scripts/run-integration-tests.sh`](../scripts/run-integration-tests.sh),
  [`vitest.config.container.ts`](../vitest.config.container.ts),
  [`tests/container/helpers.ts`](../tests/container/helpers.ts:4).
- No dependency on M2 or M3.

## Detailed Steps

### 1. New test file `tests/container/sqlite-busy-repro.test.ts`

**Gating:** Gate the entire suite on a dedicated env var
`RUN_SYNC_LOCK_TESTS=1`. This is separate from `RUN_INTEGRATION_TESTS` because
the test is slow, deliberately destructive to a throwaway volume, and requires
`docker` CLI access from the test-runner. Default: test is skipped.

**Lock-holder mechanism:**
1. Before the test, seed the `joplin-mcp` container with data via MCP tools
   (`create_folder` + `create_note`) using [`createTestClient()`](../tests/container/helpers.ts:7).
   Record expected note count (≥1).
2. Hold the lock via `docker exec` into the `joplin-mcp` container running a
   Node process that opens `database.sqlite` with `better-sqlite3` and takes
   an `BEGIN EXCLUSIVE` transaction, sleeping 90s:
   ```
   docker exec <joplin-mcp-container> node -e "
     const Database = require('better-sqlite3');
     const db = new Database('/home/joplin/.config/joplin/database.sqlite');
     db.pragma('journal_mode = WAL');
     db.exec('BEGIN EXCLUSIVE');
     setTimeout(() => process.exit(0), 90000);
   "
   ```
   The `better-sqlite3` module is a transitive dependency of the globally
   installed `joplin@3.7.1` package. If the require path differs in the image,
   fall back to bundling a tiny lock-holder script in the test-runner and
   `docker cp` + `docker exec` it into the target container.
3. Wait ~3s for the lock to be established.

**Trigger sync:** Execute `docker exec <joplin-mcp-container> joplin sync`
(direct CLI invocation inside the container — the periodic entrypoint loop is
idle because `SYNC_INTERVAL_SECONDS=9999` in the test compose). Capture
stdout/stderr and exit code.

**Assertions (current code → FAIL):**
- Sync output or captured logs contain `SQLITE_BUSY` or `database is locked`.
- Sync output contains `Current database version` with a null/empty value
  **or** `Upgrading database from version 0`.
- After the failed sync, note count via MCP `search_notes` or `joplin ls`
  equals 0 (data destroyed).

**M2 flip contract (commented-out for now, enabled after M2):**
After M2, the same test asserts the SAFE behavior:
- Sync output contains an abort marker (`[SYNC_ABORT]` or circuit-breaker
  halt message).
- Absence of `Upgrading database from version 0`.
- Note count is unchanged (≥1, data preserved).
- Non-zero exit code or explicit sync-refusal log line.

Mark the assertion swap block with `// TODO(M2): flip assertions to safe
behavior` comments.

**Test-runner `docker` access:**
The test-runner container must be able to `docker exec` into the `joplin-mcp`
container. Add `/var/run/docker.sock` mount and install the `docker` CLI
client in the test-runner service of [`docker-compose.test.yml`](../docker-compose.test.yml).
This follows the pattern already used in [`scripts/measure-initial-sync.sh`](../scripts/measure-initial-sync.sh:50).
Scope the socket mount to test-runner only; never expose from `joplin-mcp`.

### 2. Runner script wiring

- [`scripts/run-integration-tests.sh`](../scripts/run-integration-tests.sh):
  Pass `RUN_SYNC_LOCK_TESTS` through to the test-runner container environment
  (same mechanism used for `RUN_INTEGRATION_TESTS` and `MCP_URL`). Default: off.
- [`vitest.config.container.ts`](../vitest.config.container.ts):
  No change needed (serial execution already forced). Verify the new test
  file is picked up by the existing glob.

### 3. CI wiring

- `.github/workflows/integration-tests.yml`: Add a **separate, manually
  triggered job** (or `workflow_dispatch` input) that sets
  `RUN_SYNC_LOCK_TESTS=1`. Do NOT run on every PR — it is slow and
  intentionally destructive to its throwaway volume. Annotate the job with
  a comment explaining it reproduces issue #27.

### 4. Documentation

- `README.md`: Add a section documenting the new gating env var and how to
  run the repro locally (`RUN_SYNC_LOCK_TESTS=1 ./scripts/run-integration-tests.sh`).

## Definition of Done

- [`tests/container/sqlite-busy-repro.test.ts`](../tests/container/sqlite-busy-repro.test.ts) exists, gated on `RUN_SYNC_LOCK_TESTS`.
- With `RUN_SYNC_LOCK_TESTS=1`, the test **reproduces the destructive signature and FAILS on current code**.
- The assertion-flip block is clearly documented and ready for M2 to enable.
- Test is deterministic (lock holder lifetime > sync timeout, ≥5s margins).
- Test-runner container can `docker exec` into `joplin-mcp` (compose file updated).
- Regular integration tests (`RUN_INTEGRATION_TESTS=1`) still pass and are unaffected.
- CI wiring: optional gated job added; regular pipeline unchanged.
- `README.md` updated.
- Git commit made (e.g. `Add SQLITE_BUSY destructive-migration repro test`).

## Verification

1. `docker compose -f docker-compose.test.yml down -v` (clean state).
2. `RUN_SYNC_LOCK_TESTS=1 ./scripts/run-integration-tests.sh` → new test fails
   on destructive-signature assertion; captured logs show `SQLITE_BUSY` and
   `Upgrading database from version 0`.
3. Run twice consecutively (fresh volume each time) → identical failure
   (consistency).
4. `docker compose -f docker-compose.test.yml down -v` afterwards.
5. Without `RUN_SYNC_LOCK_TESTS`, new test is skipped; all other tests green.

## Non-goals

- Any fix or mitigation (M2).
- Patching upstream Joplin CLI `JoplinDatabase.js`.
- Running this repro in the default CI pipeline on every push.
- Testing HTTP-side SQLITE_BUSY retry in [`src/data-client.ts`](../src/data-client.ts:226).

## Risks

- **Lock-holder fragility:** The `better-sqlite3` module path inside the
  globally installed `joplin` package may differ per version. Mitigated by
  a verification sub-step and a documented fallback (bundle a tiny lock-holder
  script in the test-runner, `docker cp` + `docker exec` into the target).
- **`docker.sock` in test-runner:** Security trade-off accepted because it is
  test-infra only and the compose file is never used in production.
- **Flakiness from sync duration:** First sync in a fresh container can take
  time before hitting the DB read. Mitigated by pre-populating data and
  generous timeouts (120s window while holder keeps lock 90s+).
- **Upstream log-format drift:** Joplin CLI pinned at 3.7.1; signature
  patterns are pinned to that version and documented as such.
