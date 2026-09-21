# M1 — SQLite Busy Reproduction Integration Test (REVISED)

> **Revision note:** The original plan's core assumptions were empirically
> disproven during verification of commit `e60afb3`:
> (1) `better-sqlite3` does **not** exist in the image — joplin@3.7.1 ships
> `sqlite3`; (2) a bare `BEGIN EXCLUSIVE` acquires no lock until a statement
> runs inside the transaction; (3) the destructive signatures live in
> `/home/joplin/.config/joplin/log.txt`, **not** container stdout; (4) the
> existing test file was vacuous (never awaited the holder, never read log.txt).
> A lock-holder mechanism was **proven working inside the container** and this
> revision is built entirely on that evidence. See
> [Investigation evidence](#investigation-evidence-authoritative).

## Goal

Create a container integration test that deterministically reproduces the
SQLITE_BUSY data-destruction scenario from GitHub issue #27: an exclusive
SQLite write lock held by another process causes `joplin sync` to treat the
database version as `null` and re-run schema migrations from version 0,
destroying all data.

**Test contract:** the test asserts the **SAFE** behavior (no destructive
migration, data preserved) and therefore **FAILS on current container code**
— proving the bug exists — and flips to PASS once M2's fixes land, with
**zero assertion edits**. A mechanism-validation gate ensures the test can
never pass vacuously (a missing/ineffective lock fails the test with an
explicit message, not a false "safe" pass).

## Background

GitHub issue #27 reports that when the SQLite write lock on
`database.sqlite` is held by another process, a concurrent `joplin sync`
receives `SQLITE_BUSY: database is locked` when reading the `version` table.
Upstream `JoplinDatabase.ts` (joplin@3.7.1, `initialize()` at lines
1032–1053) swallows the error after its retry budget, leaves `versionRow`
as `null`, concludes the database is brand-new, and re-runs migrations from
version 0 — destroying all data. Verified in production: profiles destroyed,
notes silently zeroed.

### Investigation evidence (authoritative)

- **Retry budget:** Joplin's DB wrapper `tryCall`
  (`/usr/local/lib/node_modules/joplin/node_modules/@joplin/lib/database.ts:117-171`
  in the image) retries SQLITE_BUSY with 50ms×1.5^n backoff until
  `totalWaitTime ≥ 20000ms`, plus ~1s node-sqlite3 busy timeout per attempt
  → **~43s total wall-clock budget**.
- **Bare `BEGIN EXCLUSIVE` acquires NO lock** until a statement executes
  inside the transaction. The holder MUST run e.g.
  `SELECT count(*) FROM sqlite_master` inside the txn.
- **Measured holds:** 25s and 45s survived (version read succeeded at lock
  release); **90s hold triggered the destructive path**. Holder must hold
  ≥90s; this plan uses **120s** for margin.
- **Destructive path:** `selectOne('SELECT * FROM version LIMIT 1')` throws
  SQLITE_BUSY after budget → error logged at info and swallowed →
  `versionRow` null → version=0 → `upgradeDatabase(0)` re-runs migrations.
- **Timing:** the version read is the FIRST DB statement of `joplin sync`,
  ~1–2s after process start, right after log line
  `Checking for database schema update...`. The lock must be in place
  **before** `joplin sync` launches.
- **node-sqlite3 default `busy_timeout` = 1000ms**; the driver sets none.
- **Mechanism is journal-mode-independent** (test image observed
  `journal_mode=delete`).
- **Proven holder** (ran successfully in the container):

  ```js
  const s = require('/usr/local/lib/node_modules/joplin/node_modules/sqlite3').verbose();
  const db = new s.Database('/home/joplin/.config/joplin/database.sqlite', s.OPEN_READWRITE, () => {
    db.serialize(() => {
      db.run('BEGIN EXCLUSIVE');
      db.get('SELECT count(*) AS n FROM sqlite_master', () => {
        setTimeout(() => db.run('ROLLBACK', () => db.close()), 90000);
      });
    });
  });
  ```

- **Signatures observed in `/home/joplin/.config/joplin/log.txt`**
  (format `YYYY-MM-DD HH:MM:SS: <message>`):
  - `Error: Error: SQLITE_BUSY: database is locked: SELECT * FROM version LIMIT 1`
  - `Current database version <null>` (literal `<null>`)
  - `Upgrading database from version 0`, followed by
    `Converting database to version 1`
  - Sync stdout: `Fatal error: SQLITE_ERROR: table folders already exists: CREATE TABLE folders ...`
    (migration from 0 colliding with existing tables)
  - Healthy markers (control): `Current database version {"version":53,...}`
    and `Upgrading database from version 53`

### Assertion design decision (and why)

Two candidate shapes were considered:

1. *Assert destructive markers present* — passes today, breaks after M2.
   Wrong direction; M2 would need to delete/flip assertions.
2. **Assert SAFE behavior (chosen)** — fails today with a clear diff-style
   message, flips to PASS in M2 with no edits.

Shape 2 is chosen, with a **mechanism-validation gate** to prevent vacuous
passes: the test must first prove the lock was real before any safe-behavior
assertion is evaluated:

- `LOCK_HELD` marker awaited on the holder's stdout (no spawn-and-forget),
  plus a ~2s settle.
- An **independent lock probe**: a second short-lived node process inside the
  container attempts its own `BEGIN EXCLUSIVE` and must fail with
  SQLITE_BUSY. This proves exclusivity directly and is robust across Joplin
  versions and M2's changes (unlike probing log signatures, which may change
  post-M2).

The original plan's "TODO(M2) flip block" is **superseded**: with this design
M2 requires no assertion edits. An optional stricter post-M2 check (specific
abort marker) is noted as a comment.

## Prerequisites / Dependencies

- Docker + docker compose on the host (same as existing integration tests).
- Test infrastructure already verified working (commit `e60afb3`) — **keep
  as-is, no changes**:
  - [`docker-compose.test.yml`](../docker-compose.test.yml): `joplin-mcp`
    container name; test-runner has docker.sock mount + `RUN_SYNC_LOCK_TESTS`
    env; socket not exposed from `joplin-mcp`.
  - [`Dockerfile.tests`](../Dockerfile.tests): docker CLI installed.
  - [`scripts/run-integration-tests.sh`](../scripts/run-integration-tests.sh):
    `RUN_SYNC_LOCK_TESTS` pass-through (default 0).
  - `.github/workflows/integration-tests.yml`: manual `workflow_dispatch`
    job `sqlite-busy-repro`.
  - [`vitest.config.container.ts`](../vitest.config.container.ts): serial
    execution; existing glob already picks up the test file.
- **Rewrite required:** [`tests/container/sqlite-busy-repro.test.ts`](../tests/container/sqlite-busy-repro.test.ts)
  is vacuous (see Defects fixed below).
- No dependency on M2 or M3.

### Defects in commit `e60afb3` fixed by this plan

1. Holder used non-existent `better-sqlite3` → exited 1 in <1s; test never
   awaited its stdout → invisible failure. **Fixed:** image's `sqlite3` at
   the proven path; statement inside txn; `LOCK_HELD` awaited.
2. Assertions grepped `docker logs --tail 100`; destructive signatures live
   in `/home/joplin/.config/joplin/log.txt`. **Fixed:** log capture via
   `docker exec ... cat/tail log.txt`.
3. `SYNC_TIMEOUT_MS=60_000` vs ~43s retry budget + slow environments.
   **Fixed:** 150s sync window inside a 180s test timeout vs 120s holder.
4. [`README.md`](../README.md) claimed a "second Joplin CLI process" and a
   "deterministic contention window" that didn't exist. **Fixed:** accurate
   description (node holder process using the image's `sqlite3`).

## Detailed Steps

### 1. Rewrite `tests/container/sqlite-busy-repro.test.ts`

**Gating (unchanged):** entire suite on `RUN_SYNC_LOCK_TESTS=1`
(`describe.skip` otherwise). Default: skipped.

**Constants:**

```ts
const JOPLIN_CONTAINER = 'joplin-mcp';       // container_name in compose
const HOLDER_LIFETIME_MS = 120_000;          // ≥90s proven threshold + margin
const SETTLE_MS = 2_000;                     // after LOCK_HELD
const SYNC_TIMEOUT_MS = 150_000;             // ≥ 120s holder lifetime
// it() timeout: 180_000 (seed + lock + sync + log capture)
```

**Timing relationships (determinism margins):**

- Holder lifetime 120s ≫ ~43s Joplin retry budget → ~77s margin.
- Sync timeout 150s ≥ holder lifetime 120s → sync can never outlive the lock
  accidentally.
- Lock is established and confirmed (`LOCK_HELD` + 2s settle) **before**
  `docker exec ... joplin sync` starts (version read happens 1–2s after sync
  start).

```mermaid
sequenceDiagram
    participant T as Test (test-runner)
    participant H as Holder (in joplin-mcp)
    participant J as joplin sync (in joplin-mcp)
    T->>T: Seed MCP folder+note, count ≥1
    T->>H: spawn `docker exec node /tmp/lock-holder.js`
    H-->>T: stdout "LOCK_HELD" (await!)
    T->>T: settle 2s; probe BEGIN EXCLUSIVE → SQLITE_BUSY
    T->>J: spawn `docker exec joplin sync` (timeout 150s)
    J-->>T: exit (fatal, ≤~45s); capture stdout/stderr/code
    T->>H: pkill lock-holder.js (release lock early)
    T->>T: read log.txt via docker exec; assert SAFE behavior
```

**Lock holder:** write the script to a temp file in the test-runner, `docker cp`
it to `/tmp/lock-holder.js` in the container, then `spawn()` (NOT
spawn-and-forget) `docker exec joplin-mcp node /tmp/lock-holder.js`,
streaming stdout until `LOCK_HELD` is observed:

```js
// /tmp/lock-holder.js — uses the image's sqlite3 (joplin@3.7.1), NOT better-sqlite3
const s = require('/usr/local/lib/node_modules/joplin/node_modules/sqlite3').verbose();
const db = new s.Database('/home/joplin/.config/joplin/database.sqlite', s.OPEN_READWRITE, (err) => {
  if (err) { console.error('OPEN_FAIL', err.message); process.exit(1); }
  db.serialize(() => {
    db.run('BEGIN EXCLUSIVE', (e) => { if (e) { console.error('BEGIN_FAIL', e.message); process.exit(1); } });
    // CRITICAL: bare BEGIN EXCLUSIVE holds no lock; a statement inside the txn does.
    db.get('SELECT count(*) AS n FROM sqlite_master', (e) => {
      if (e) { console.error('STMT_FAIL', e.message); process.exit(1); }
      console.log('LOCK_HELD');
      setTimeout(() => db.run('ROLLBACK', () => db.close()), Number(process.env.HOLD_MS || 120000));
    });
  });
});
```

Any holder exit before `LOCK_HELD` must fail the test immediately with the
holder's stderr (mechanism gate — never continue without a confirmed lock).

**Lock probe (mechanism validation, part 2):** after `LOCK_HELD` + settle,
run a short one-shot `docker exec` node script that opens the same DB and
attempts `BEGIN EXCLUSIVE`; it must fail with SQLITE_BUSY. Emit
`PROBE_BUSY` on success-of-bug; if the probe *acquires* the lock, fail with
"lock not exclusive — mechanism invalid".

**Trigger sync:** `spawn('docker', ['exec', JOPLIN_CONTAINER, 'joplin', 'sync'])`,
capture stdout/stderr/exit code, timeout 150s.

**Release lock early (cleanup):** once sync has exited, the lock is no longer
needed — `docker exec joplin-mcp pkill -f lock-holder.js` (the holder's own
120s timer is the fallback). `docker compose down -v` remains the runner's
job.

**Log capture:** after the sync process has **exited**, read the file log:

```
docker exec joplin-mcp cat /home/joplin/.config/joplin/log.txt
```

(or `tail -n 300` to bound memory). Do **not** grep `docker logs` — the
migration lines do not appear on container stdout.

**Assertions — mechanism validation (must hold in M1 *and* M2):**

1. `LOCK_HELD` was observed on holder stdout (else: fail
   `lock not established — mechanism invalid: <holder stderr>`).
2. Probe reported `PROBE_BUSY` (lock was genuinely exclusive).

**Assertions — main test outcome (the M1/M2 flip point; FAIL today):**

```ts
expect(logTxt).not.toContain('Current database version <null>');
expect(logTxt).not.toContain('Upgrading database from version 0');
expect(syncOut + syncErr).not.toContain('table folders already exists');
expect(noteCountAfter).toBeGreaterThanOrEqual(1);
```

On current code these fail with the captured `logTxt` / sync output visible
in the vitest diff — a clear, self-explanatory failure proving issue #27.

Note-count fallback: MCP may itself be dead after the destructive migration.
If `list_notes` via MCP throws, fail with an explicit
`MCP unreachable after sync — data destroyed` message (do not silently
swallow); optionally cross-check with `docker exec joplin-mcp joplin ls note`.

**Post-M2 note (comment only, no active code):**

```ts
// TODO(M2): no assertion edits required — the assertions above are the safe
// behavior. Optionally tighten after M2 lands: assert the specific abort
// marker (e.g. [SYNC_ABORT] / circuit-breaker halt) in sync output, and
// assert 'Upgrading database from version 53' (or the seeded version) in log.txt.
```

**Test-runner docker access (unchanged, already in place):** socket mount +
docker CLI on test-runner only; never exposed from `joplin-mcp`.

### 2. Runner script wiring — NO CHANGES

[`scripts/run-integration-tests.sh`](../scripts/run-integration-tests.sh)
already passes `RUN_SYNC_LOCK_TESTS` through (default 0).
[`vitest.config.container.ts`](../vitest.config.container.ts) already picks
up the file. Verify only.

### 3. CI wiring — NO CHANGES

`.github/workflows/integration-tests.yml` already has the manual
`workflow_dispatch` job `sqlite-busy-repro` setting `RUN_SYNC_LOCK_TESTS=1`.
Verify only.

### 4. Documentation — README corrections

In [`README.md`](../README.md), fix the sqlite-busy repro section:

- Replace "second Joplin CLI process" with: a **plain Node process inside the
  `joplin-mcp` container** holding an exclusive SQLite transaction via the
  image's `sqlite3` module (joplin@3.7.1 dependency).
- Remove the "deterministic contention window" claim; describe the actual
  mechanism: `BEGIN EXCLUSIVE` + a statement inside the transaction,
  `LOCK_HELD` awaited before sync, ~43s upstream retry budget, 120s hold.
- State that destructive signatures are asserted from
  `/home/joplin/.config/joplin/log.txt`, and that the test currently **fails
  by design** (proving issue #27) until M2 lands.
- Keep/confirm the run instructions:
  `RUN_SYNC_LOCK_TESTS=1 ./scripts/run-integration-tests.sh`.

## Definition of Done

- [`tests/container/sqlite-busy-repro.test.ts`](../tests/container/sqlite-busy-repro.test.ts)
  rewritten per this plan, gated on `RUN_SYNC_LOCK_TESTS`.
- With `RUN_SYNC_LOCK_TESTS=1`, the test **FAILS on current code** at the
  safe-behavior assertions, with destructive signatures visible in the
  failure output (`Current database version <null>`,
  `Upgrading database from version 0`, `table folders already exists`).
- Mechanism validation is active: `LOCK_HELD` awaited + exclusive-lock probe;
  a broken mechanism fails loudly instead of passing vacuously.
- All log-based assertions read `/home/joplin/.config/joplin/log.txt` via
  `docker exec`, only after the sync process exits.
- Timing margins: holder 120s ≥ 90s proven threshold; sync timeout 150s;
  test timeout 180s.
- Holder cleanup: `pkill -f lock-holder.js` in `afterAll` + holder
  self-termination timer; runner `down -v` handles volume reset.
- Gating, compose wiring, runner pass-through, CI job, vitest glob: unchanged.
- [`README.md`](../README.md) section corrected (node holder process, real
  mechanism, accurate log-location and fail-by-design statements).
- Git commit made (e.g. `Revise SQLITE_BUSY repro test plan with proven lock mechanism`).

## Verification

1. `docker compose -f docker-compose.test.yml down -v` (clean state).
2. `RUN_SYNC_LOCK_TESTS=1 ./scripts/run-integration-tests.sh` →
   **expect FAIL**: mechanism validation passes (`LOCK_HELD` awaited, probe
   busy), then safe-behavior assertion fails showing
   `Upgrading database from version 0` / `Current database version <null>`
   in the captured `log.txt` and/or `table folders already exists` in sync
   output.
3. Run twice consecutively (fresh volume each run) → identical failure
   (deterministic).
4. Without `RUN_SYNC_LOCK_TESTS` (or `=0`), the test is skipped; all other
   integration tests remain green.
5. `docker compose -f docker-compose.test.yml down -v` afterwards.

## Non-goals

- Any fix or mitigation (M2).
- Patching upstream Joplin CLI `JoplinDatabase.ts`.
- Running this repro in the default CI pipeline on every push.
- Testing HTTP-side SQLITE_BUSY retry in [`src/data-client.ts`](../src/data-client.ts:226).

## Risks

- ~~`better-sqlite3` availability~~ **Removed** — disproven; the holder uses
  the image's `sqlite3` at the proven path
  `/usr/local/lib/node_modules/joplin/node_modules/sqlite3`.
- **sqlite3 module path pinned to joplin@3.7.1 image:** the require path
  changes if the joplin version/base image changes. Mitigation: holder fails
  loudly with `OPEN_FAIL` before `LOCK_HELD`, so drift is caught as an
  explicit mechanism failure, not a false pass; update the pinned path when
  bumping joplin.
- **Retry-budget drift across joplin versions:** the ~43s budget derives from
  `tryCall` constants (20s cap + 1s busy timeout) in `database.ts`; upstream
  may change them. Mitigation: 120s holder lifetime gives ~77s margin; the
  25s/45s/90s measured thresholds should be re-validated on any joplin bump.
- **Upstream log-format drift:** signatures pinned to joplin@3.7.1 and
  documented as such; mechanism validation (LOCK_HELD + probe) is
  log-independent, so drift degrades to a failed assertion, not a vacuous
  pass.
- **`docker.sock` in test-runner:** security trade-off accepted — test-infra
  only; the compose file is never used in production.

---

## Post-implementation addendum (branch `testing`, HEAD ca00441)

Two residual defects were fixed after the initial implementation:

1. **Lock holder robustness (Defect 1):** The `LOCK_SCRIPT` now sets
   `PRAGMA busy_timeout = 10000` before `BEGIN EXCLUSIVE` and retries the
   `BEGIN EXCLUSIVE` with exponential backoff (500ms × 1.5^n, up to ~30s
   total) on `SQLITE_BUSY`. Previously, the holder failed instantly when
   another suite had an in-flight write, aborting the test at the gate.

2. **Isolated invocation (Defect 2):** The gated repro now runs in its own
   `vitest run` invocation (targeting only `sqlite-busy-repro.test.ts`) after
   the regular suite completes. The destructive `joplin sync` re-runs
   migrations from version 0 under the held exclusive lock, which kills the
   shared `joplin-mcp` container's Data API. Running it in the same vitest
   invocation as other suites caused sibling failures (`fetch failed /
   ENOTFOUND joplin-mcp`) because `vitest.config.container.ts` disables
   `sequence.concurrent` but file parallelism remained on, allowing suite
   overlap during the lock window. The isolated invocation eliminates this
   race. `vitest.config.container.ts` was not modified.

3. **Death-safe log capture and window-scoped assertions (Defects A–D):** The
   sync exec and log.txt read are now performed in a **single** `docker exec`
   session (`date +%s; joplin sync; sleep 2; tail -n 400 log.txt`), so log
   content is captured before the container can die (Defects B, D). A
   `parseLogTimestamp` helper window-scores log lines to those timestamped at
   or after the sync start, avoiding false positives from the entrypoint's
   startup migration (Defect C). Log-based assertions now run **before** the
   MCP note-count check, which is wrapped in try/catch and skipped on failure
   (Defect A).

4. **Volume-backed capture (capture-channel defect):** The combined exec's
   stdout is unreliable because the entrypoint liveness monitor tears down
   the container when the Data API dies during the destructive migration,
   killing the exec (rc 137) before `tail` output reaches the FIFO. The
   sync exec now writes everything to a capture file on the `joplin_data`
   volume (`sync-capture.txt`); a helper container mounting the same volume
   polls for `CAPTURE_DONE` and reads the file. Capture preconditions
   (`Number.isFinite(syncStartEpoch)`, non-empty log) assert before the
   signature checks, preventing vacuous passes.

## Post-implementation addendum 2 (branch `testing`, HEAD 182bb4c)

Three harness defects were reproduced empirically, fixed, and then re-verified
by running the gated acceptance suite twice and the ungated suite once.

### Harness defects fixed

1. **Lock-holder script arrived empty.** `docker exec` without `-i` does not
   forward the client's stdin, so piping `LOCK_SCRIPT` into
   `sh -c "cat > /tmp/lock-holder.js"` produced a 0-byte file and the holder
   exited before `LOCK_HELD`. The script is now written to a temp file in the
   test-runner and delivered with `docker cp`, and its byte count is asserted
   before the holder is spawned.
2. **Volume read-back used the wrong path.** The helper container read the
   absolute in-container path (`/home/joplin/.config/joplin/sync-capture.txt`)
   while its own CWD is not the data directory, so `cat` failed and the read
   silently returned `''`. Reads now resolve to the helper's mount point
   (`/vol/<name>`). The volume name is resolved from `docker inspect`; the
   unprefixed `joplin_data` fallback is gone, because Compose names the volume
   `joplin-mcp_joplin_data` and an unresolved name now fails loudly instead of
   mounting a nonexistent volume.
3. **Capture command was a shell syntax error.** The joined command list was
   passed without `sh -c`, so the outer shell parsed the leading `{` as a word
   (`syntax error near unexpected token '}'`, rc 2) and nothing ran — no
   capture file was ever created. The container-side commands now live in a
   `docker cp`-delivered script executed as `sh /tmp/sync-capture.sh`, which
   removes the double-shell quoting hazard entirely.

### Containment defect found while verifying the fixes

Fixing the three defects exposed a fourth problem that blocked the
acceptance signature: the capture file stopped at 22 bytes (epoch +
`SYNC_START`).

- **Cause:** the entrypoint's liveness monitor SIGKILLs the container's
  process tree roughly 44s into the sync, as soon as the destructive migration
  takes the Data API down. The script's post-sync `sleep 2; tail -n 1000` is
  killed with it, so the log was never written. The 150s watchdog `timeout` is
  irrelevant here because it never gets to fire.
- **Fix:** the capture script now streams `log.txt` for the whole sync window
  instead of reading it afterwards, and `exec` redirects the script's stdout to
  the capture file so the streamed tail inherits it. It emits `SYNC_EXIT` from
  the sync's own exit code, then `sync` flushes to the volume before teardown.
  A watchdog rc of 124 maps to 137 so a watchdog kill is not mistaken for
  joplin's exit code.
- **Consequence:** because the log now precedes `SYNC_EXIT` in the file, log
  extraction changed to "everything after `SYNC_START`, minus the capture's own
  control lines" (position-independent), and the window's upper bound derives
  from the container-written `SYNC_START` epoch rather than the test-runner
  clock. A dead container with content is now treated as a final capture, so
  the poll loop no longer burns its remaining budget.

### Verification results

- `tsc --noEmit` in the test image: exit 0.
- Gated run (`RUN_SYNC_LOCK_TESTS=1`), twice from a fresh volume: regular phase
  5 suites passed / 1 skipped (30 tests passed / 4 skipped), then the repro
  failed on the window-scoped `Current database version <null>` assertion with a
  visible vitest diff, and the runner reported the expected non-zero repro exit.
- Ungated run: all green, repro skipped, no repro-phase banner.

The window's lower bound is load-bearing: the entrypoint legitimately logs
`Current database version <null>` and `Upgrading database from version 0` when
it creates the database on a fresh volume, so an unbounded match would fail
even against safe code.
