# M2 — SQLite Busy Fixes, Serialization, and Deletion Circuit-Breaker

> **Revision note:** Revised per plan review (verdict NEEDS CHANGES) plus
> empirical verification against Joplin CLI 3.7.1. Key corrections: the plan
> is now framed honestly as **damage limitation** (detection + halt +
> circuit-breaker) plus sync-vs-sync serialization — flock does **not**
> prevent the first destructive sync-vs-Data-API race (issue #27), because
> the Data API never takes the flock. `database.busyTimeout` was empirically
> **rejected** by joplin 3.7.1 and is removed as a fix step. `flock` was
> empirically confirmed present in the image. Item-count commands were
> corrected after the originally specified commands failed silently. The
> halt mechanism no longer kills the sync loop (killing trips the parent
> liveness monitor and restarts the container). The M1 test-flip step was
> rewritten: the flip already happened in M1.
>
> **Second revision (per re-review, F1–F3):** (F1) The entrypoint runs under
> `set -euo pipefail`; all parent-shell invocations of `get_sync_item_count`
> and `check_deletion_circuit_breaker` must be in conditional contexts
> (`|| VAR="skip"` / `if ... ; then`), and the breaker validates **both**
> pre- and post-counts before any arithmetic — a trip (`return 2`) or skip
> (`return 1`) from an unguarded call would otherwise kill the parent shell
> before MCP/Data API start (crash loop). (F2) The Step 6 initial-sync
> snippet is replaced with a complete, transcribable restructure of the
> outer `if/elif/else` block. (F3) A post-count of exactly 0 with a
> pre-count > 0 is treated as a suspicious `joplin ls` failure: retry once,
> then WARN and skip — never trip on it.

## Goal

Limit the damage from the SQLITE_BUSY data-destruction scenario described in
GitHub issue #27. The container **cannot prevent** the first destructive sync
(see Design below), so it must (a) **detect** the destructive signatures in
sync logs, (b) **halt** all further syncs via a persistent marker file, and
(c) **halt sync via a deletion circuit-breaker** when a sync would delete too
many entries. Additionally: serialize sync-vs-sync with flock (this protects
against the *real* overlap races: initial vs periodic vs cleanup syncs
running concurrently), and update the stale M1 test scaffolding
(header comment / TODO markers) to reflect that the safe-behavior assertions
already exist.

## Background

GitHub issue #27 reports data destruction: when the Joplin Data API holds
the SQLite write lock on `database.sqlite`, a concurrent `joplin sync` call
receives `SQLITE_BUSY: database is locked` when reading the `version` table.
The upstream Joplin CLI (`JoplinDatabase.js`, pinned at 3.7.1) then treats
the version as `null`, runs schema migrations from version 0, and destroys
all data. The combined container runs the Data API and `joplin sync`
concurrently against the same profile with no serialization.

This milestone adds: (a) abort-don't-migrate **detection**, (b) a
**halt marker** that permanently refuses further syncs, (c) a **deletion
circuit-breaker**, (d) **flock serialization** for sync-vs-sync overlap, and
(e) cleanup of the stale M1 test scaffolding.

**Honest limitation (issue #27, C1):** flock serializes only CLI-level
`joplin sync` invocations — the Data API (`joplin server start`) never takes
the flock, so flock does **not** prevent the sync-vs-Data-API contention that
triggers issue #27. `database.busyTimeout` was rejected by joplin 3.7.1 (see
Step 4). The first destructive sync therefore **cannot be prevented** at the
container level without patching upstream code (a non-goal). This plan
provides: real prevention of sync-vs-sync overlap races, plus fast detection
and permanent halt so the destructive sync can happen at most **once** per
halt marker.

## Prerequisites / Dependencies

- **M1 must be complete.** The repro test
  ([`tests/container/sqlite-busy-repro.test.ts`](../tests/container/sqlite-busy-repro.test.ts))
  exists and its safe-behavior assertions are already in place; M2 only
  removes its stale scaffolding (Step 9).

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
destructive** patterns and returns a distinct exit code. Use **process
substitution** for the offset tail (matching the existing
`check_sync_errors` style at line 90 — no `eval`-built command, also
shellcheck-friendly):

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
        if [ "${f}" = "${JOPLIN_LOG_FILE}" ] && [ "${log_offset}" -gt 0 ]; then
            if grep -i -q -E "${dangerous_pattern}" <(tail -n +"${log_offset}" "${f}" 2>/dev/null) 2>/dev/null; then
                log "ERROR" "[${label}] DANGEROUS sync signature detected in ${f} — sync halted to limit data destruction"
                log "ERROR" "[${label}] Issue #27: ${f} contains destructive pattern; refusing further syncs"
                return 2
            fi
        else
            if grep -i -q -E "${dangerous_pattern}" "${f}" 2>/dev/null; then
                log "ERROR" "[${label}] DANGEROUS sync signature detected in ${f} — sync halted to limit data destruction"
                log "ERROR" "[${label}] Issue #27: ${f} contains destructive pattern; refusing further syncs"
                return 2
            fi
        fi
    done
    return 0
}
```

**Rationale for return code 2:** Callers can distinguish "sync had normal
errors" (return 1, from `check_sync_errors`) from "sync hit a destructive
signature" (return 2, from `check_sync_danger`). The entrypoint uses this to
create the halt marker.

### Step 2 — Halt marker file for permanent sync disable

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh)**

Define a halt marker path near the top (~line 30), next to where
`JOPLIN_PROFILE_DIR` is defined (it is defined at line 30 but **not
exported** — the marker path is resolved at declaration time, so no export
is needed for the parent shell):

```bash
SYNC_HALT_MARKER="${JOPLIN_PROFILE_DIR}/.sync-halt"
```

Because `${JOPLIN_PROFILE_DIR}` is on the profile volume, the marker
**survives container restarts and Docker restart-policy recreation** — a
destructive sync can happen at most once per marker file. Verify this in the
verification pass (Step 10 / Verification).

Add a **halt-check gate** at the very beginning of the periodic sync loop
body (inside the `bash -c` block at line 324, before `log_sync "START"`).
**Do NOT kill the sync loop** — killing it would trip the parent liveness
monitor ([`entrypoint-combined.sh`](../entrypoint-combined.sh:473), ~line
486 `wait -n` over the MCP/Data API PIDs plus entrypoint-combined.sh
cleanup semantics at ~line 473 — a dead loop subshell is reaped and the
container exits, Docker restarts, and the initial-sync race repeats).
Instead, keep the loop alive with a sleep+continue gate:

```bash
if [ -f "${SYNC_HALT_MARKER}" ]; then
    log "ERROR" "Sync halt marker exists — refusing to sync (see ${SYNC_HALT_MARKER})"
    log "ERROR" "Remove ${SYNC_HALT_MARKER} to re-enable sync after investigating issue #27"
    sleep "${SYNC_INTERVAL_SECONDS}"
    continue
fi
```

Also gate the initial sync (~line 297, i.e. before `log_sync "START"`
"Performing initial sync..." at line 297) and the cleanup final sync
(~line 460, before the final-sync block) with the same check (the cleanup
gate uses a plain `if ! [ -f ... ]` guard around the final sync; there is no
loop to `continue` there).

When `check_sync_danger()` returns 2 — at any sync site — **create the halt
marker** and rely on the gate above to refuse all future syncs. There is no
`kill` of the sync loop anywhere:

```bash
echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [SYNC_ABORT] Destructive sync signature detected — sync halted. See issue #27." > "${SYNC_HALT_MARKER}"
```

### Step 3 — Serialization: flock around all `joplin sync` / `joplin` CLI calls

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh)**

`flock` is empirically present in the node:22-bookworm-slim image
(`/usr/bin/flock`, util-linux 2.38.1) — no installation needed. Optionally
add a cheap guard for defense: `command -v flock >/dev/null || { log "ERROR" "flock not found"; exit 1; }`.

Define a flock path near the top (~line 30):

```bash
SYNC_LOCK_FILE="${JOPLIN_PROFILE_DIR}/.sync-flock"
```

Wrap **every** `joplin sync` invocation in `flock` to serialize sync-vs-sync:

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

Also flock-wrap the item-count invocations in `get_sync_item_count`
(Step 5) with the same `SYNC_LOCK_FILE`, so the count is taken while no
other CLI sync is mid-flight.

The `-w 120` timeout ensures the sync will not block indefinitely if another
CLI sync is stuck. If the lock cannot be acquired within 120s, the sync
aborts with an error rather than hanging.

**Note on Data API contention (honest limitation):** The Data API
(`joplin server start`) holds its own SQLite connection and never takes this
flock — we cannot inject flock into its internals. Therefore flock does
**not** prevent the issue #27 sync-vs-Data-API race; it only prevents
sync-vs-sync overlap (initial vs periodic vs cleanup). The issue #27 race is
handled by **detection + halt marker** (Steps 1, 2, 6) and the deletion
circuit-breaker (Step 5). Document this trade-off in the README.

### Step 4 — Document that `database.busyTimeout` is unsupported

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh)** (and
[`README.md`](../README.md), in Step 10)

**Investigation note (empirically settled):** Joplin CLI 3.7.1 **rejects**
`database.busyTimeout`: `joplin config database.busyTimeout 30000` prints
`Unknown key: database.busyTimeout` and exits 1; the value is never stored;
Joplin's own code never reads a busyTimeout setting anywhere. Do **not** add
any `joplin config database.busyTimeout` call — no configuration attempt is
made. Instead, add a documentation-only startup note after the CLI config
section (~line 167, after `joplin config sync.10.password`):

```bash
# database.busyTimeout is NOT supported by Joplin CLI 3.7.1 (`joplin config
# database.busyTimeout` → "Unknown key"). The container relies on flock
# serialization (sync-vs-sync) plus detection + halt-marker circuit-breaking
# for the Data API contention race (issue #27).
log "WARN" "database.busyTimeout not supported by Joplin CLI 3.7.1 — relying on flock serialization + detection circuit-breaker (see issue #27)"
```

### Step 5 — Deletion circuit-breaker

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh)**

Add new environment variable default near the top (~line 134, in the
defaults section at lines 132–135):

```bash
SYNC_MAX_DELETE_COUNT="${SYNC_MAX_DELETE_COUNT:-100}"
```

Add a **pre-sync item-count snapshot** function near the top (after
`log_sync`). **Verified against Joplin 3.7.1:** the previously considered
`joplin ls /notes -l 99999` is wrong — `-l` is long-format (not a limit),
`/notes` is not a valid path, and both mistakes fail **silently** (exit 0,
empty output). The correct commands are `joplin ls -n 99999` for notes and
`joplin ls /` for folders. Reads succeed under the lock (WAL), so counts are
reliable even during contention — but a failed/unparseable count must cause
a **skip with WARN**, never a `0` (a post-count of 0 after a real pre-count
would false-trip the breaker). Wrap each `joplin ls` in `flock` with the
same `SYNC_LOCK_FILE`:

```bash
get_sync_item_count() {
    # Returns counts on stdout; echoes "skip" and returns nonzero on failure
    # (caller treats a failed count as skip-with-WARN, never as 0).
    local notes folders
    if ! notes=$(flock -w 60 "${SYNC_LOCK_FILE}" joplin ls -n 99999 2>/dev/null | wc -l); then
        log "WARN" "get_sync_item_count: note count failed — skipping check"
        echo "skip"
        return 1
    fi
    if ! folders=$(flock -w 60 "${SYNC_LOCK_FILE}" joplin ls / 2>/dev/null | wc -l); then
        log "WARN" "get_sync_item_count: folder count failed — skipping check"
        echo "skip"
        return 1
    fi
    echo "$((notes + folders))"
}
```

Add a **post-sync deletion check** function. Return-code contract: **0** =
check passed, **1** = check skipped (WARN; no marker written), **2** =
breaker tripped (halt marker already written inside the function).

**`set -e` invariant (entrypoint-combined.sh line 2 runs
`set -euo pipefail`):** The initial-sync and cleanup-final-sync sites run in
that parent shell. Therefore:

1. Every `check_deletion_circuit_breaker` invocation **must be in a
   conditional context** — `check_deletion_circuit_breaker ... || RC=$?`
   or `if check_deletion_circuit_breaker ...; then` — **never a bare
   call**: a bare call returning 1 (skip) or 2 (trip) would terminate the
   entrypoint under `set -e` before MCP/Data API start → Docker restart →
   crash loop. The trip path (`return 2`) is only ever reached safely
   because callers invoke the function conditionally; the function itself
   never exits the entrypoint.
2. The post-count assignment inside the function must itself be guarded:
   `post_count=$(get_sync_item_count) || post_count="skip"` (an assignment's
   exit status is the command substitution's, so a bare assignment would
   kill the parent shell on the skip path).
3. **Both** `pre_count` and `post_count` are validated as
   positive-integer-or-zero (or `"skip"`) **before any arithmetic** —
   `$((pre_count - post_count))` with a non-numeric operand is a fatal
   arithmetic error under `set -e`.
4. The periodic-sync site runs inside the `setsid bash -c` subshell
   (line 324), which does **not** inherit `set -e` (fresh non-interactive
   `bash -c` starts with default options). Conditional-context invocation
   is **still required there** for uniformity and future-proofing.

```bash
check_deletion_circuit_breaker() {
    local label="$1"
    local pre_count="$2"

    # SYNC_MAX_DELETE_COUNT = -1 disables the circuit breaker.
    if [ "${SYNC_MAX_DELETE_COUNT}" -lt 0 ]; then
        return 0
    fi

    # Validate BOTH counts BEFORE any arithmetic (set -e: a "skip" or
    # non-numeric operand in $(( )) would be a fatal arithmetic error).
    if [ -z "${pre_count}" ] || [ "${pre_count}" = "skip" ] || ! [ "${pre_count}" -ge 0 ] 2>/dev/null; then
        log "WARN" "[${label}] Pre-sync item count invalid ('${pre_count}') — skipping deletion circuit-breaker check"
        return 1
    fi

    local post_count
    post_count=$(get_sync_item_count) || post_count="skip"  # guarded: skip path must not kill the caller
    if [ -z "${post_count}" ] || [ "${post_count}" = "skip" ] || ! [ "${post_count}" -ge 0 ] 2>/dev/null; then
        log "WARN" "[${label}] Post-sync item count failed — skipping deletion circuit-breaker check"
        return 1
    fi

    # Suspicious-zero guard (F3): `joplin ls` can fail silently (exit 0,
    # empty output). A post-count of exactly 0 when pre_count > 0 must NOT
    # trip the breaker — retry once; if still 0, WARN and skip.
    if [ "${post_count}" -eq 0 ] && [ "${pre_count}" -gt 0 ]; then
        log "WARN" "[${label}] Post-sync count is 0 with pre-sync count ${pre_count} — suspicious (possible joplin ls failure); retrying once"
        post_count=$(get_sync_item_count) || post_count="skip"
        if [ -z "${post_count}" ] || [ "${post_count}" = "skip" ] || ! [ "${post_count}" -ge 0 ] 2>/dev/null || [ "${post_count}" -eq 0 ]; then
            log "WARN" "[${label}] Post-sync count still 0/failed after retry — skipping deletion circuit-breaker check (no trip)"
            return 1
        fi
    fi

    local deleted=$((pre_count - post_count))
    if [ "${deleted}" -lt 0 ]; then
        deleted=0  # Items were added, not deleted
    fi

    if [ "${deleted}" -gt "${SYNC_MAX_DELETE_COUNT}" ]; then
        log "ERROR" "[${label}] CIRCUIT BREAKER TRIPPED: sync deleted ${deleted} items (threshold: ${SYNC_MAX_DELETE_COUNT})"
        log "ERROR" "[${label}] Pre-sync count: ${pre_count}, post-sync count: ${post_count}"
        log "ERROR" "[${label}] Writing halt marker to prevent further syncs (see ${SYNC_HALT_MARKER})"
        echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [CIRCUIT_BREAKER] ${deleted} items deleted (threshold: ${SYNC_MAX_DELETE_COUNT}). Pre-sync: ${pre_count}, post-sync: ${post_count}. Sync halted. See issue #27." > "${SYNC_HALT_MARKER}"
        return 2
    fi

    log "INFO" "[${label}] Deletion check passed: ${deleted} items deleted (threshold: ${SYNC_MAX_DELETE_COUNT})"
    return 0
}
```

**Disable semantics (decided):** `SYNC_MAX_DELETE_COUNT=-1` disables the
circuit breaker via the `-lt 0` guard above. (`0` is a legitimate threshold —
"delete nothing" — not a disable value; `[ deleted -gt 0 ]` trips on any
deletion when the threshold is 0.)

**Wire into all three sync sites** (all invocations in conditional
contexts — see the `set -e` invariant above):

- **Initial sync** (~line 297): Take
  `PRE_SYNC_COUNT=$(get_sync_item_count) || PRE_SYNC_COUNT="skip"`
  before the sync (never a bare assignment — its failure would kill the
  parent shell under `set -e`); after the sync and error/danger checks,
  call the breaker conditionally and act on the return code — e.g.
  `BREAKER_RC=0; check_deletion_circuit_breaker "Initial" "${PRE_SYNC_COUNT}" || BREAKER_RC=$?`.
  If it returns 2: create nothing extra (the breaker already wrote the
  marker) — the periodic loop is simply **not started** (skip the
  `setsid bash -c` block at line 324); the halt gate refuses forever once
  the marker exists and a future container start also skips starting the
  loop. If it returns 1: skip (WARN already logged), continue normally.
- **Periodic sync** (inside the `bash -c` block, ~line 324): Same pattern
  with conditional-context invocation (see Step 6 for the wiring and
  exports).
- **Cleanup final sync** (~line 460): Take the pre-count with the same
  `|| PRE_SYNC_COUNT="skip"` guard; call the breaker conditionally; if it
  returns 2 log a warning but do not halt (we're shutting down anyway; the
  marker is still written so the next start refuses to sync).

### Step 6 — Wire detection into all three sync sites

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh)**

For each sync site, after the existing `check_sync_errors` call, add
`check_sync_danger` and `check_deletion_circuit_breaker`. On trip: create
the halt marker and rely on the gate (Step 2) — **never kill the sync loop**
and never exit the entrypoint (see Step 2 rationale).

- **Initial sync** (~line 296–312): `check_sync_danger` must run in **both**
  the nonzero-exit branch **and** the `elif` branch — a lock error makes
  `joplin sync` exit nonzero, taking the first branch at line 302, so
  checking only in the `elif` would miss it. The existing outer block at
  lines 302–312 must be **restructured in full** — the snippet below is the
  complete replacement for lines 302–312 and is transcribable as-is (note:
  `check_sync_danger` returns 2 for a destructive signature and 0 for none;
  it is invoked only inside `if` conditions or via the `|| var=$?` capture
  — both conditional contexts — so `set -e` cannot abort here):

  ```bash
  START_PERIODIC_LOOP=1
  if [ "${SYNC_EXIT}" -ne 0 ]; then
      log_sync "FAIL" "Initial sync failed (exit code: ${SYNC_EXIT})"
      log "ERROR" "Sync stderr output:"
      cat "${LOG_DIR}/sync-stderr.log" >&2
      log "ERROR" "Last 20 lines of Joplin log (log.txt):"
      tail -n 20 "${JOPLIN_LOG_FILE}" >&2 || log "WARN" "log.txt not found or empty"
      # Destructive-signature check ALSO in the nonzero-exit branch (a lock
      # error exits nonzero and lands here, not in the elif):
      DANGER_RC=0
      check_sync_danger "Initial" "${LOG_TAIL_START}" || DANGER_RC=$?
      if [ "${DANGER_RC}" -eq 2 ]; then
          log_sync "ABORT" "Destructive signature detected in failed sync — halting"
          echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [SYNC_ABORT] Destructive sync signature detected — sync halted. See issue #27." > "${SYNC_HALT_MARKER}"
          START_PERIODIC_LOOP=0
      fi
  else
      ERR_RC=0
      check_sync_errors "Initial" "${LOG_TAIL_START}" || ERR_RC=$?
      if [ "${ERR_RC}" -ne 0 ]; then
          log_sync "FAIL" "Initial sync reported errors despite exit code 0"
          DANGER_RC=0
          check_sync_danger "Initial" "${LOG_TAIL_START}" || DANGER_RC=$?
          if [ "${DANGER_RC}" -eq 2 ]; then
              log_sync "ABORT" "Destructive signature detected — halting"
              echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [SYNC_ABORT] Destructive sync signature detected — sync halted. See issue #27." > "${SYNC_HALT_MARKER}"
              START_PERIODIC_LOOP=0
          fi
      else
          log_sync "PASS" "Initial sync completed successfully"
      fi
  fi
  ```

  The restructure converts the original `elif ! check_sync_errors ...` into
  a nested `if` inside the `else` branch (a `! cmd || ERR_RC=$?` pattern
  cannot distinguish `check_sync_errors`' return codes from
  `check_sync_danger`'s in one chain, so both checks are captured into
  variables first). After the block, guard the `setsid bash -c` block
  (line 324) with the decision variable — and skip starting the loop on a
  breaker trip too (Step 5 wiring sets it to 0):

  ```bash
  if [ "${START_PERIODIC_LOOP}" = "1" ]; then
      setsid bash -c '...' &
      SYNC_LOOP_PID=$!
  else
      log "ERROR" "Periodic sync loop not started — halt marker present (see ${SYNC_HALT_MARKER})"
  fi
  ```

  (If the breaker tripped, the halt marker already exists; a further
  refinement is optional: `[ "${START_PERIODIC_LOOP}" = "1" ] && [ ! -f "${SYNC_HALT_MARKER}" ]`
  as the guard condition.)

- **Periodic sync** (inside `bash -c` at line 324): Same
  `check_sync_danger` pattern in both the nonzero-exit and `elif` branches
  (mirror lines 336–346), using the same `DANGER_RC=0; check_sync_danger ... || DANGER_RC=$?`
  conditional-context capture as the initial site — the subshell does **not**
  inherit `set -e` (fresh non-interactive `bash -c`), but the conditional
  pattern is required there too for uniformity and future-proofing. On trip:
  write the halt marker and let the loop
  **continue** — the next iteration's halt gate (Step 2) sleeps and skips.
  Do not `exit` the subshell, do not `kill` the loop. The deletion breaker
  runs after the danger check with the same conditional capture and a
  `|| PRE_SYNC_COUNT="skip"` pre-count guard.

- **Cleanup final sync** (~line 457–468): Gate on the halt marker first
  (skip the final sync if it exists); run `check_sync_danger` and the
  deletion breaker after; log but do not create extra halt machinery beyond
  the marker the breaker/danger check already writes (container is shutting
  down; the marker survives restart).

**Exports for the `bash -c` block:** The loop body is a separate `bash -c`
process and sees neither unexported variables nor shell functions. Extend:

- line 322:
  ```bash
  export SYNC_INTERVAL_SECONDS LOG_DIR LOG_FILE SYNC_LOG_FILE JOPLIN_LOG_FILE SYNC_HALT_MARKER SYNC_LOCK_FILE SYNC_MAX_DELETE_COUNT
  ```
- line 323:
  ```bash
  export -f log log_sync check_sync_errors check_sync_danger get_sync_item_count check_deletion_circuit_breaker
  ```
- and update the comment block at lines 317–321 listing the exported
  variables and functions to match.

### Step 7 — Config wiring

**File: [`entrypoint-combined.sh`](../entrypoint-combined.sh:132–135)**
Add default for `SYNC_MAX_DELETE_COUNT` in the defaults section (covered in
Step 5).

**File: [`.env.example`](../.env.example:26)**
Add after `SYNC_INTERVAL_SECONDS` (line 26):
```bash
# Maximum number of items that sync may delete before the circuit breaker
# trips and halts further syncs (default: 100).  Set to -1 to disable the
# deletion circuit breaker (0 is a valid threshold: it trips on any deletion).
# See issue #27.
# SYNC_MAX_DELETE_COUNT=100
```

**File: [`src/config.ts`](../src/config.ts:38)**
Three insertion points:
- Schema (lines 38–43, alongside `syncIntervalSeconds`):
  ```typescript
  syncMaxDeleteCount: z.coerce
      .number()
      .int()
      .min(-1)
      .default(100)
      .describe('SYNC_MAX_DELETE_COUNT'),
  ```
- Env map (line 57, alongside `syncIntervalSeconds`):
  ```typescript
  syncMaxDeleteCount: process.env['SYNC_MAX_DELETE_COUNT'],
  ```
- Error-message env var list (lines 74–76):
  ```
    SYNC_MAX_DELETE_COUNT (optional, default: 100, -1 disables the deletion circuit-breaker)
  ```

**File: [`tests/config.test.ts`](../tests/config.test.ts)**
Add `SYNC_MAX_DELETE_COUNT` to the `ENV_VARS` allowlist (lines 3–11) and add
boundary tests following the existing pattern (lines 170–178): accept `100`,
accept `0` (valid threshold), accept `-1` (disable), reject `-2` (below the
`.min(-1)` bound), reject non-integer.

### Step 8 — Shell tests

**File: [`tests/test-check-sync-errors.sh`](../tests/test-check-sync-errors.sh)**

The harness **duplicates `check_sync_errors` verbatim** from
entrypoint-combined.sh (comment at line 13, copy at lines 14–~48) — update
that duplicated copy **in lockstep** with the new `combined_pattern` from
Step 1. Add the new functions to the harness **the same way** (duplicated
verbatim, consistent with existing style): copy `check_sync_danger`,
`get_sync_item_count`, and `check_deletion_circuit_breaker` verbatim from
the entrypoint.

For `check_deletion_circuit_breaker` tests, the harness needs a **`joplin`
stub on `PATH`** (the function shells out to `joplin ls`): create a stub
script that echoes a fixture listing, and point `PATH` at it before invoking
the function; vary the stub's output between pre/post invocations to
simulate deletion.

Add test cases for the new `check_sync_danger()` function:
- `SQLITE_BUSY` in sync-stdout.log → return 2
- `Upgrading database from version 0` in log.txt (with offset window) → return 2
- `database is locked` in sync-stderr.log → return 2
- No dangerous patterns → return 0
- Missing log files → return 0 (safe default)

Add test cases for `check_deletion_circuit_breaker()`:
- Deletion count > threshold → return 2, halt marker created
- Deletion count ≤ threshold → return 0, no marker
- `SYNC_MAX_DELETE_COUNT=-1` → return 0 without counting (disabled)
- Failed/unparseable `joplin ls` output (stub emits garbage / exits 1) →
  return 1 with WARN (skip), **not** a false trip
- Pre-sync count equals post-sync count → return 0
- **Pre-count invalid** (harness calls with `pre_count="skip"` or a
  non-numeric value) → return 1 (skip) with WARN, **no arithmetic error**,
  no marker
- **Suspicious zero** (post-count 0 with pre-count > 0): the breaker
  retries the count once; if the retry still returns 0/"skip" → return 1
  (skip) with WARN, **no trip and no marker**; if the retry returns > 0,
  the normal comparison proceeds
- Structure checks: no bare (unconditional) `check_deletion_circuit_breaker`
  or `get_sync_item_count` invocation at any sync site; the post-count
  assignment inside the breaker is guarded with `|| post_count="skip"`

**File: [`tests/test-sync-failure-diagnostics.sh`](../tests/test-sync-failure-diagnostics.sh)**

Add structure-validation tests:
- `check_sync_danger` function is exported
- `SYNC_HALT_MARKER` is defined
- `SYNC_LOCK_FILE` is defined
- `flock` wraps all three `joplin sync` call sites
- Halt marker gate exists in periodic loop
- No `kill` of the sync loop tied to destructive detection (loop stays alive)
- `get_sync_item_count` function is exported
- `SYNC_MAX_DELETE_COUNT` exported (with `-1` disable semantics)

### Step 9 — Remove stale M1 test scaffolding

**File: [`tests/container/sqlite-busy-repro.test.ts`](../tests/container/sqlite-busy-repro.test.ts)** (created in M1)

The M1 flip **already happened**: the safe-behavior assertions
(no destructive signatures; note count preserved) are in place at lines
617–644. This step only removes the now-stale scaffolding:

- Update the header comment (lines 10–15): it still says "This test must
  FAIL against the current container code" — rewrite it to describe the
  current contract (asserts safe behavior; M2 detection/halt must keep these
  assertions passing).
- Remove the `TODO(M2)` comment block at lines 646–649.
- Optionally tighten **only absence-assertions** (e.g. windowed log must
  not contain `[SYNC_ABORT]`-adjacent destructive signatures in a scenario
  where prevention applies). Do **NOT** require abort-marker presence in
  the output: a clean sync under prevention would fail such an assertion,
  and the M1 scenario (held lock, no M2 fix for Data-API contention) may
  legitimately still produce a destructive outcome whose *detection* is
  verified by the shell tests instead.

### Step 10 — Documentation updates

**File: [`README.md`](../README.md)**

- Update the SQLITE_BUSY caveat (~line 242–246) to explain the new
  container-level fixes honestly: **damage limitation** (detection + halt
  marker + circuit-breaker) and sync-vs-sync flock serialization; state
  explicitly that the first sync-vs-Data-API destructive sync (issue #27)
  cannot be prevented without upstream changes, and that `database.busyTimeout`
  is not supported by Joplin CLI 3.7.1.
- Update sync architecture sections (~lines 352–354 and 584–585) to
  describe the serialization and circuit-breaker.
- Add the new env var (`SYNC_MAX_DELETE_COUNT`, with `-1` = disable) to the
  configuration table.
- Document the recovery procedure: remove
  `${JOPLIN_PROFILE_DIR}/.sync-halt` (on the profile volume, survives
  restarts) to re-enable sync after investigating.

**File: [`CHANGELOG.md`](../CHANGELOG.md)**

Add under `## [Unreleased]` → `### Fixed`, using the repository's real
issue-URL convention as used in 0.2.1
(`https://github.com/gelse/joplin-mcp/issues/<n>`):
```markdown
- Detect destructive SQLITE_BUSY signatures in sync logs and halt sync via a
  persistent marker file, limiting the issue #27 data-destruction scenario to
  at most one occurrence ([#27](https://github.com/gelse/joplin-mcp/issues/27))
- Add flock serialization around all `joplin sync` invocations (sync-vs-sync;
  does not cover Data API contention — see issue #27)
- Add deletion circuit-breaker (`SYNC_MAX_DELETE_COUNT`, `-1` disables) that
  halts sync when too many items would be deleted
```

## Definition of Done

- `check_sync_danger()` function added and wired into all three sync sites,
  in **both** the nonzero-exit and `elif` branches of the initial site.
- Halt marker (`${JOPLIN_PROFILE_DIR}/.sync-halt`) prevents further syncs
  after destructive signature or circuit-breaker trip; verified to survive
  container restarts (profile volume).
- The sync loop is **never killed** on detection; the sleep+continue gate
  keeps it alive and refusing.
- `flock` wraps all three `joplin sync` call sites (initial, periodic,
  cleanup) plus the `get_sync_item_count` invocations.
- No `joplin config database.busyTimeout` call exists; the WARN log line /
  README note documents why.
- Deletion circuit-breaker: pre/post item count comparison using the
  verified `joplin ls -n 99999 | wc -l` / `joplin ls / | wc -l` commands,
  threshold via `SYNC_MAX_DELETE_COUNT` env var, `-1` disables, failed
  or invalid counts (pre **or** post) skip with WARN (`return 1`),
  suspicious post-count-of-0 retries once then skips without tripping,
  halt marker on trip, and **every invocation at every sync site is in a
  conditional context** (`set -e`-safe).
- Config wired: `entrypoint-combined.sh`, `.env.example`, `src/config.ts`
  (schema + env map + error list), `tests/config.test.ts`.
- Shell tests updated: [`tests/test-check-sync-errors.sh`](../tests/test-check-sync-errors.sh)
  (duplicated `check_sync_errors` copy updated in lockstep; new functions
  duplicated; `joplin` stub for breaker tests) and
  [`tests/test-sync-failure-diagnostics.sh`](../tests/test-sync-failure-diagnostics.sh).
- Exports at lines 322–323 and their comment (lines 317–321) include the
  new variables and functions.
- M1 test scaffolding de-staled (header comment, TODO removal); safe-behavior
  assertions unchanged → test **PASSES**.
- `README.md` and `CHANGELOG.md` updated (issue link:
  `https://github.com/gelse/joplin-mcp/issues/27`).
- Git commit made (e.g. `Add SQLITE_BUSY detection, sync serialization, and deletion circuit-breaker`).

## Verification

> **Environment note:** `pnpm test` and `shellcheck` must run inside the
> devcontainer/CI — the host has no node/npx installed.

1. **M1 repro test still PASSES**: `RUN_SYNC_LOCK_TESTS=1 ./scripts/run-integration-tests.sh` —
   the lock-contention test keeps asserting safe behavior after the
   scaffolding cleanup.
2. **Manual lock-holder test**: Start a container, hold the SQLite lock via
   `docker exec`, trigger sync — verify the destructive signature is
   detected, the halt marker is created, and (after container restart) no
   further syncs run (marker survived; the initial sync is gated and the
   periodic loop's gate refuses). No data loss beyond the first sync.
3. **Circuit-breaker test**: Pre-seed > `SYNC_MAX_DELETE_COUNT` items, mock
   a sync that deletes them — verify halt marker created, sync loop stays
   alive but skips every subsequent interval (gate logs, sleeps, continues).
4. **Disable-semantics test**: `SYNC_MAX_DELETE_COUNT=-1` → breaker returns
   0 without counting; `SYNC_MAX_DELETE_COUNT=0` → any deletion trips.
5. **Regular integration tests**: `RUN_INTEGRATION_TESTS=1 ./scripts/run-integration-tests.sh` —
   all existing tests still pass.
6. **Shell tests**: `bash tests/test-check-sync-errors.sh` and
   `bash tests/test-sync-failure-diagnostics.sh` — all pass (including the
   `-1` disable and failed-count-skip cases).
7. **Unit tests**: `pnpm test` (devcontainer/CI) — all pass
   (config.test.ts with new env var boundaries: 100, 0, -1 accepted; -2
   rejected).
8. **shellcheck**: `shellcheck entrypoint-combined.sh` (devcontainer/CI) —
   no new warnings; no `eval` introduced by Step 1.
9. **Manual recovery test**: Remove `.sync-halt` file, verify sync resumes.
10. **Restart-survival test**: With the halt marker present, restart the
    container — verify neither initial sync nor the periodic loop sync
    (marker on the profile volume survives).

## Non-goals

- **Preventing the first issue #27 destructive sync.** The Data API never
  takes the flock and `database.busyTimeout` is unsupported in 3.7.1 — the
  first destructive sync-vs-Data-API sync cannot be prevented at the
  container level; this plan limits the damage to at most one occurrence.
- Patching upstream Joplin CLI `JoplinDatabase.js` (out of scope).
- Pausing the Data API during sync (we don't control its internals).
- Parsing `joplin sync` stdout for deletion stats (the pre/post item count
  approach is more reliable and independent of CLI output format).
- Adding `sqlite3` CLI tool to the production image.
- Killing the sync loop or exiting the entrypoint on detection (trips the
  parent liveness monitor → container restart → loop repeats).

## Risks

- **`flock` does not cover Data API contention (issue #27).** This is the
  accepted core limitation: detection + halt marker is the mitigation, and
  it is documented as such in README and CHANGELOG.
- **Pre-sync item count is a snapshot; concurrent MCP writes could skew it.**
  Acceptable — the circuit-breaker is a safety net, not a precise audit log.
  The threshold is deliberately generous (default 100).
- **Item counts can be slow on large profiles** (`joplin ls -n 99999`).
  Flock-wrapped with a 60 s wait; on failure the check is skipped with WARN
  rather than false-tripping.
- **Flock timeout (120s) may be too short or too long.** Configurable via
  env var if needed; 120s chosen to be generous but not hang the container.
- **Halt marker must be manually removed.** This is intentional — forces the
  operator to investigate before resuming. Document recovery procedure in
  README. Marker lives on the profile volume and survives restarts by design.
