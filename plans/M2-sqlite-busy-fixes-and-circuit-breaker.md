# M2 — SQLite Busy Fixes, Serialization, and Deletion Circuit-Breaker

## Goal

Implement container-level fixes that prevent the SQLITE_BUSY data-destruction
scenario described in GitHub issue #27. The fixes must ensure the Joplin CLI
can **never** conclude version is `null` and re-run schema migrations from
version 0 when the Data API holds the SQLite lock. Implement a deletion
circuit-breaker that halts sync when it would delete too many entries.
Additionally, flip the M1 repro test to assert the **safe** behavior.

## Background

GitHub issue #27 reports data destruction: when the Joplin Data API holds
the SQLite write lock on `database.sqlite`, a concurrent `joplin sync` call
receives `SQLITE_BUSY: database is locked` when reading the `version` table.
The upstream Joplin CLI (`JoplinDatabase.js`, pinned at 3.7.1) then treats
the version as `null`, runs schema migrations from version 0, and destroys
all data. The combined container runs the Data API and `joplin sync`
concurrently against the same profile with no serialization. This milestone
adds: (a) abort-don't-migrate detection, (b) serialization via flock, (c) a
deletion circuit-breaker, and (d) the M1 test flip.

## Prerequisites / Dependencies

- **M1 must be complete.** M2 depends on the repro test existing and
  flipping its assertions from FAIL to PASS.

## Detailed Steps

### Step 1 — Add destructive log-pattern detection to `check_sync_errors()`

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh:69)**

Extend the `combined_pattern` regex at line 72 to also match the destructive
signatures:

```
combined_pattern='\[error\]|There was some errors|Could not encrypt item|Master key is not loaded|SQLITE_BUSY|database is locked|Upgrading database from version 0|Current database version.*null'
```

Add a **new function** `check_sync_danger()` immediately after
`check_sync_errors()` (~line 108) that checks for the **specifically
destructive** patterns and returns a distinct exit code:

```bash
check_sync_danger() {
    local label="$1"
    local log_offset="${2:-0}"
    local dangerous_pattern='SQLITE_BUSY|database is locked|Upgrading database from version 0|Current database version.*null'

    local files=(
        "${JOPLIN_LOG_FILE}"
        "${LOG_DIR}/sync-stdout.log"
        "${LOG_DIR}/sync-stderr.log"
    )

    for f in "${files[@]}"; do
        [ -f "${f}" ] || continue
        local search_cmd="cat '${f}'"
        if [ "${f}" = "${JOPLIN_LOG_FILE}" ] && [ "${log_offset}" -gt 0 ]; then
            search_cmd="tail -n +${log_offset} '${f}'"
        fi
        if eval "${search_cmd}" 2>/dev/null | grep -i -q -E "${dangerous_pattern}"; then
            log "ERROR" "[${label}] DANGEROUS sync signature detected in ${f} — sync is ABORTED to prevent data destruction"
            log "ERROR" "[${label}] Issue #27: ${f} contains destructive pattern; refusing further syncs"
            return 2  # Distinct from check_sync_errors return 1
        fi
    done
    return 0
}
```

**Rationale for return code 2:** Callers can distinguish "sync had normal
errors" (return 1, from `check_sync_errors`) from "sync hit a destructive
signature" (return 2, from `check_sync_danger`). The entrypoint uses this
to decide whether to abort the sync loop entirely.

### Step 2 — Halt marker file for permanent sync disable

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh)**

Define a halt marker path near the top (~line 30):

```bash
SYNC_HALT_MARKER="${JOPLIN_PROFILE_DIR}/.sync-halt"
```

Add a **halt-check gate** at the very beginning of the periodic sync loop
body (inside the `bash -c` block at line 324, before `log_sync "START"`):

```bash
if [ -f "${SYNC_HALT_MARKER}" ]; then
    log "ERROR" "Sync halt marker exists — refusing to sync (see ${SYNC_HALT_MARKER})"
    log "ERROR" "Remove ${SYNC_HALT_MARKER} to re-enable sync after investigating issue #27"
    sleep "${SYNC_INTERVAL_SECONDS}"
    continue
fi
```

Also gate the initial sync (~line 297) and the cleanup final sync (~line 460)
with the same check.

When `check_sync_danger()` returns 2, **create the halt marker**:

```bash
echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [SYNC_ABORT] Destructive sync signature detected — sync halted. See issue #27." > "${SYNC_HALT_MARKER}"
```

After creating the marker, **kill the periodic sync loop** (same pattern as
cleanup lines 390–409):

```bash
if [ -n "${SYNC_LOOP_PID:-}" ] && kill -0 "${SYNC_LOOP_PID}" 2>/dev/null; then
    log "ERROR" "Killing sync loop (PID: ${SYNC_LOOP_PID}) due to destructive signature"
    kill -TERM -- -"${SYNC_LOOP_PID}" 2>/dev/null || true
fi
```

### Step 3 — Serialization: flock around all `joplin sync` / `joplin` CLI calls

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh)**

Define a flock path near the top (~line 30):

```bash
SYNC_LOCK_FILE="${JOPLIN_PROFILE_DIR}/.sync-flock"
```

Wrap **every** `joplin sync` invocation in `flock` to serialize access:

- **Initial sync** (line 300):
  ```bash
  flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin sync' > "${LOG_DIR}/sync-stdout.log" 2> "${LOG_DIR}/sync-stderr.log" || SYNC_EXIT=$?
  ```
- **Periodic sync** (line 334, inside `bash -c`):
  ```bash
  flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin sync' > "${SYNC_STDOUT}" 2> "${SYNC_STDERR}" || SYNC_EXIT=$?
  ```
- **Cleanup final sync** (line 461):
  ```bash
  if flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin sync' > /dev/null 2>&1; then
  ```

The `-w 120` timeout ensures the sync will not block indefinitely if another
holder (e.g. the Data API) is stuck. If the lock cannot be acquired within
120s, the sync aborts with an error rather than hanging.

**Note on Data API pausing:** The Data API (`joplin server start`) holds its
own SQLite connection and we cannot inject flock into its internal operation
(we don't control its source code). The flock around `joplin sync` means the
CLI waits for the Data API to release its lock. Combined with
`busy_timeout` (Step 4), this is the best we can do without upstream changes.
Document this trade-off in the README.

### Step 4 — PRAGMA busy_timeout

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh)**

After the Joplin CLI configuration section (~line 167, after
`joplin config sync.10.password`), set the busy timeout for SQLite:

```bash
# Set SQLite busy timeout so joplin CLI waits instead of failing immediately
# when the Data API holds the lock.  30 seconds is generous enough to ride
# out a brief Data API operation without masking a true deadlock.
joplin config database.busyTimeout 30000 2>/dev/null || true
```

**Investigation note:** Joplin CLI 3.7.1 supports
`joplin config database.busyTimeout` (sets the SQLite busy_timeout pragma).
If the config key is not available in the pinned version, document why and
rely entirely on flock (Step 3) as the serialization mechanism. In that case,
add a log line: `log "WARN" "database.busyTimeout config not available — relying on flock for serialization"`.

### Step 5 — Deletion circuit-breaker

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh)**

Add new environment variable defaults near the top (~line 134):

```bash
SYNC_MAX_DELETE_COUNT="${SYNC_MAX_DELETE_COUNT:-100}"
```

Add a **pre-sync item-count snapshot** function near the top (after
`log_sync`):

```bash
get_sync_item_count() {
    local count=0
    local output
    output=$(joplin ls /notes -l 99999 2>/dev/null | wc -l || echo 0)
    count=$((count + output))
    output=$(joplin ls /folders -l 99999 2>/dev/null | wc -l || echo 0)
    count=$((count + output))
    echo "${count}"
}
```

Add a **post-sync deletion check** function:

```bash
check_deletion_circuit_breaker() {
    local label="$1"
    local pre_count="$2"

    local post_count
    post_count=$(get_sync_item_count)

    local deleted=$((pre_count - post_count))
    if [ "${deleted}" -lt 0 ]; then
        deleted=0  # Items were added, not deleted
    fi

    if [ "${deleted}" -gt "${SYNC_MAX_DELETE_COUNT}" ]; then
        log "ERROR" "[${label}] CIRCUIT BREAKER TRIPPED: sync would delete ${deleted} items (threshold: ${SYNC_MAX_DELETE_COUNT})"
        log "ERROR" "[${label}] Pre-sync count: ${pre_count}, post-sync count: ${post_count}"
        log "ERROR" "[${label}] Writing halt marker to prevent further syncs (see ${SYNC_HALT_MARKER})"
        echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [CIRCUIT_BREAKER] ${deleted} items deleted (threshold: ${SYNC_MAX_DELETE_COUNT}). Pre-sync: ${pre_count}, post-sync: ${post_count}. Sync halted. See issue #27." > "${SYNC_HALT_MARKER}"
        return 2
    fi

    log "INFO" "[${label}] Deletion check passed: ${deleted} items deleted (threshold: ${SYNC_MAX_DELETE_COUNT})"
    return 0
}
```

**Wire into all three sync sites:**

- **Initial sync** (~line 297):
  ```bash
  PRE_SYNC_COUNT=$(get_sync_item_count)
  # ... existing sync + error checks ...
  if ! check_deletion_circuit_breaker "Initial" "${PRE_SYNC_COUNT}"; then
      log_sync "ABORT" "Circuit breaker tripped — sync loop disabled"
      # Kill the sync loop
      # ... (same pattern as Step 2) ...
  fi
  ```

- **Periodic sync** (inside `bash -c` block, ~line 324): Same pattern.
  Export `SYNC_MAX_DELETE_COUNT`, `SYNC_HALT_MARKER`, `get_sync_item_count`,
  `check_deletion_circuit_breaker` in the `export -f` line at line 323.

- **Cleanup final sync** (~line 460): Check deletion circuit breaker; log
  warning if tripped but do not halt (we're shutting down anyway).

### Step 6 — Wire detection into all three sync sites

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh)**

For each sync site, after the existing `check_sync_errors` call, add
`check_sync_danger`:

- **Initial sync** (~line 308): After the `elif ! check_sync_errors` block:
  ```bash
  elif ! check_sync_danger "Initial" "${LOG_TAIL_START}"; then
      log_sync "ABORT" "Destructive signature detected — aborting sync loop"
      echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [SYNC_ABORT] ..." > "${SYNC_HALT_MARKER}"
      # Kill sync loop + exit
  fi
  ```

- **Periodic sync** (inside `bash -c`): Same pattern. On abort, the
  subshell exits and the parent reaps it.

- **Cleanup final sync**: Log but do not create halt marker (container is
  shutting down).

### Step 7 — Config wiring

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh:133–135)**
Add default for `SYNC_MAX_DELETE_COUNT` in the defaults section.

**File: [`.env.example`](../.env.example:26)**
Add after `SYNC_INTERVAL_SECONDS`:
```bash
# Maximum number of items that sync may delete before the circuit breaker
# trips and halts further syncs (default: 100).  Set to 0 to disable the
# deletion circuit breaker.  See issue #27.
# SYNC_MAX_DELETE_COUNT=100
```

**File: [`src/config.ts`](../src/config.ts:38)**
Add to the config schema:
```typescript
syncMaxDeleteCount: z.coerce
    .number()
    .int()
    .min(0)
    .default(100)
    .describe('SYNC_MAX_DELETE_COUNT'),
```
And in the `parseConfig` env map (~line 57):
```typescript
syncMaxDeleteCount: process.env['SYNC_MAX_DELETE_COUNT'],
```

**File: [`tests/config.test.ts`](../tests/config.test.ts)**
Add `SYNC_MAX_DELETE_COUNT` to the `ENV_VARS` allowlist and add boundary
tests (0, 100, negative rejection).

### Step 8 — Shell tests

**File: [`tests/test-check-sync-errors.sh`](../tests/test-check-sync-errors.sh)**

Add test cases for the new `check_sync_danger()` function:
- `SQLITE_BUSY` in sync-stdout.log → return 2
- `Upgrading database from version 0` in log.txt → return 2
- `database is locked` in sync-stderr.log → return 2
- No dangerous patterns → return 0
- Missing log files → return 0 (safe default)

Add test cases for `check_deletion_circuit_breaker()`:
- Deletion count > threshold → return 2, halt marker created
- Deletion count ≤ threshold → return 0, no marker
- Pre-sync count equals post-sync count → return 0

**File: [`tests/test-sync-failure-diagnostics.sh`](../tests/test-sync-failure-diagnostics.sh)**

Add structure-validation tests:
- `check_sync_danger` function is exported
- `SYNC_HALT_MARKER` is defined
- `SYNC_LOCK_FILE` is defined
- `flock` wraps all three `joplin sync` call sites
- Halt marker gate exists in periodic loop
- `get_sync_item_count` function is exported

### Step 9 — Flip M1 test assertions

**File: [`tests/container/sqlite-busy-repro.test.ts`](../tests/container/sqlite-busy-repro.test.ts)** (created in M1)

Change the assertion block from asserting the destructive signature to
asserting the **safe** behavior:
- Sync output contains `[SYNC_ABORT]` or `[CIRCUIT_BREAKER]` or `halt marker`.
- Absence of `Upgrading database from version 0`.
- Note count is unchanged (data preserved).
- Sync loop is killed / sync refused on retry.

Remove the `// TODO(M2): flip assertions` comments. The test should now
**PASS** with M2's fixes in place.

### Step 10 — Documentation updates

**File: [`README.md`](../README.md)**

- Update the SQLITE_BUSY caveat (~line 242–246) to explain the new
  container-level fixes (flock, busy_timeout, circuit-breaker).
- Update sync architecture sections (~lines 352–354 and 584–585) to
  describe the serialization and circuit-breaker.
- Add the new env vars (`SYNC_MAX_DELETE_COUNT`) to the configuration table.

**File: [`CHANGELOG.md`](../CHANGELOG.md)**

Add under `## [Unreleased]` → `### Fixed`:
```markdown
- Prevent `SQLITE_BUSY` data destruction when Data API holds SQLite lock
  during sync ([#27](https://github.com/owner/repo/issues/27))
- Add serialization (flock) around all `joplin sync` invocations
- Add deletion circuit-breaker (`SYNC_MAX_DELETE_COUNT`) that halts sync
  when too many items would be deleted
```

## Definition of Done

- `check_sync_danger()` function added and wired into all three sync sites.
- Halt marker (`${JOPLIN_PROFILE_DIR}/.sync-halt`) prevents further syncs
  after destructive signature or circuit-breaker trip.
- `flock` wraps all three `joplin sync` call sites (initial, periodic,
  cleanup).
- `PRAGMA busy_timeout` configured (or documented as unavailable).
- Deletion circuit-breaker: pre/post item count comparison, threshold via
  `SYNC_MAX_DELETE_COUNT` env var, halt marker on trip.
- Config wired: `entrypoint-combined.sh`, `.env.example`, `src/config.ts`,
  `tests/config.test.ts`.
- Shell tests updated: [`tests/test-check-sync-errors.sh`](../tests/test-check-sync-errors.sh)
  and [`tests/test-sync-failure-diagnostics.sh`](../tests/test-sync-failure-diagnostics.sh).
- M1 test flipped to assert safe behavior → test **PASSES**.
- `README.md` and `CHANGELOG.md` updated.
- Git commit made (e.g. `Add SQLITE_BUSY fixes, serialization, and deletion circuit-breaker`).

## Verification

1. **M1 repro test now PASSES**: `RUN_SYNC_LOCK_TESTS=1 ./scripts/run-integration-tests.sh` — the
   lock-contention test asserts safe behavior and passes.
2. **Manual lock-holder test**: Start a container, hold the SQLite lock via
   `docker exec`, trigger sync — verify sync aborts with `[SYNC_ABORT]` in
   logs, halt marker is created, no data loss.
3. **Circuit-breaker test**: Pre-seed > `SYNC_MAX_DELETE_COUNT` items, mock
   a sync that deletes them — verify halt marker created, sync loop stops.
4. **Regular integration tests**: `RUN_INTEGRATION_TESTS=1 ./scripts/run-integration-tests.sh` —
   all existing tests still pass.
5. **Shell tests**: `bash tests/test-check-sync-errors.sh` and
   `bash tests/test-sync-failure-diagnostics.sh` — all pass.
6. **Unit tests**: `pnpm test` — all pass (config.test.ts with new env var).
7. **shellcheck**: `shellcheck entrypoint-combined.sh` — no new warnings.
8. **Manual recovery test**: Remove `.sync-halt` file, verify sync resumes.

## Non-goals

- Patching upstream Joplin CLI `JoplinDatabase.js` (out of scope).
- Pausing the Data API during sync (we don't control its internals).
- Parsing `joplin sync` stdout for deletion stats (the pre/post item count
  approach is more reliable and independent of CLI output format).
- Adding `sqlite3` CLI tool to the production image.

## Risks

- **`database.busyTimeout` config key may not exist in Joplin 3.7.1.**
  Mitigated by the fallback log line and reliance on flock.
- **Pre-sync item count is a snapshot; concurrent MCP writes could skew it.**
  Acceptable — the circuit-breaker is a safety net, not a precise audit log.
- **Flock timeout (120s) may be too short or too long.** Configurable via
  env var if needed; 120s chosen to be generous but not hang the container.
- **Halt marker must be manually removed.** This is intentional — forces the
  operator to investigate before resuming. Document recovery procedure in
  README.
