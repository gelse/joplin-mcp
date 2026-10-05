#!/usr/bin/env bash
# Unit tests for check_sync_errors() and friends from entrypoint-combined.sh
# (M2-T3 adds: expanded combined_pattern coverage, check_e2ee_state(),
# decrypt_stderr_summary()).
set -euo pipefail

# --- Paths (SCRIPT_DIR used by the export -f pin assertion, Group 5) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Stub log functions (suppress output) ---
log() { :; }
log_sync() { :; }

# --- Joplin profile / log path (mirrors entrypoint-combined.sh) ---
JOPLIN_PROFILE_DIR="${JOPLIN_PROFILE_DIR:-/home/joplin/.config/joplin}"
JOPLIN_LOG_FILE="${JOPLIN_PROFILE_DIR}/log.txt"

# --- Copy check_sync_errors() exactly from entrypoint-combined.sh (lines 69-108) ---
# NOTE: This duplication is DELIBERATE (test independence from entrypoint refactors;
# code review 2026-09-21, finding S1 — user-confirmed accepted harness pragmatism).
# If you change these functions in entrypoint-combined.sh, you MUST mirror the change
# here in the SAME commit, or these tests validate stale logic and pass vacuously.
check_sync_errors() {
    local label="$1"
    local log_offset="${2:-0}"
    local combined_pattern='\[error\]|There was some errors|Could not encrypt item|Master key is not loaded|no master key is currently loaded|DecryptionWorker|SQLITE_BUSY|database is locked|Upgrading database from version 0|Current database version.*null'

    local files=(
        "${JOPLIN_LOG_FILE}"
        "${LOG_DIR}/sync-stdout.log"
        "${LOG_DIR}/sync-stderr.log"
    )

    local match=false
    for f in "${files[@]}"; do
        if [ ! -f "${f}" ]; then
            if [ "${f}" = "${JOPLIN_LOG_FILE}" ]; then
                log "WARN" "[${label}] ${f} not found — sync error detection limited to stdout/stderr logs"
            fi
            continue
        fi

        if [ "${f}" = "${JOPLIN_LOG_FILE}" ] && [ "${log_offset}" -gt 0 ]; then
            if grep -i -q -E "${combined_pattern}" <(tail -n +"${log_offset}" "${f}" 2>/dev/null) 2>/dev/null; then
                match=true
                break
            fi
        else
            if grep -i -q -E "${combined_pattern}" "${f}" 2>/dev/null; then
                match=true
                break
            fi
        fi
    done

    if [ "${match}" = true ]; then
        log "WARN" "[${label}] Sync log files contain error patterns — sync may have encountered issues despite exit code 0"
        return 1
    fi

    return 0
}

# --- Copy check_sync_danger() exactly from entrypoint-combined.sh ---
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

# --- Copy get_sync_item_count() exactly from entrypoint-combined.sh ---
get_sync_item_count() {
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

# --- Copy decrypt_stderr_summary() + check_e2ee_state() exactly from
# --- entrypoint-combined.sh (M2-T3; region between get_sync_item_count and
# --- check_deletion_circuit_breaker) ---
# NOTE: verbatim copy, same deliberate-duplication rule as above — if you
# change these functions in entrypoint-combined.sh, mirror the change here in
# the SAME commit. check_e2ee_state's probe JS is the SQLite probe re-based
# per the M2-T3 plan amendment (the drafted `[Encrypted]` grep is void).
# -----------------------------------------------------------------------------
# Flattened, length-capped tail of the current decrypt attempt's stderr
# (backlog §5 F1a): the retry loop's per-attempt WARN previously surfaced
# none of e2ee-decrypt-stderr.log, leaving per-attempt failures opaque.
# Never fails (a missing/unreadable log yields an empty string): the caller
# embeds the result inside a log line. LOCKSTEP: copied verbatim into
# tests/test-check-sync-errors.sh (deliberate duplication, test independence).
# -----------------------------------------------------------------------------
decrypt_stderr_summary() {
    tail -n 2 "${LOG_DIR}/e2ee-decrypt-stderr.log" 2>/dev/null | tr '\n' ' ' | cut -c 1-300 || true
}

# -----------------------------------------------------------------------------
# Post-decrypt E2EE state check (M2-T3)
# Detection re-based per the plan's 2026-10-04 amendment on M2-T1's read-only
# SQLite probe — the drafted `joplin ls -l | grep '[Encrypted]'` probe is
# VOID: joplin 3.7.1 emits no such marker (Spike 3 comment in the M2-T1 block
# below). Counts rows with non-empty encryption_cipher_text instead.
# Return-code contract (mirrors check_deletion_circuit_breaker): 0 = PASS,
# 1 = SKIP-WARN (reserved; not currently produced), 2 = TRIP (writes the
# [E2EE_DECRYPT_INCOMPLETE] halt marker).
# Deliberate fail-closed deviation from the plan draft: the draft's "probe
# failed → warn, do not halt" (return 1) was converted to a TRIP so a probe
# that cannot confirm zero encrypted items never passes silently — same
# semantics as the verification gate's `case` in the M2-T1 block below.
# The probe is flock-wrapped with SYNC_LOCK_FILE (60 s) so it does not race a
# concurrent sync (same convention as get_sync_item_count).
# LOCKSTEP: the probe JS below duplicates the E2EE_VERIFY_SCRIPT in the M2-T1
# block and the inline node probe in Dockerfile.combined's HEALTHCHECK CMD
# (same SQL: rows with non-empty encryption_cipher_text across notes, folders,
# resources, tags, note_tags, revisions). Update all three in the same commit.
# The JS must stay free of single quotes: it is assigned via a single-quoted
# shell string.
# -----------------------------------------------------------------------------
check_e2ee_state() {
    local label="$1"

    # JOPLIN_MASTER_PASSWORD not set ⇒ nothing to check (no E2EE expected).
    if [ -z "${JOPLIN_MASTER_PASSWORD:-}" ]; then
        return 0
    fi

    local e2ee_state_probe_script='const s = require("/usr/local/lib/node_modules/joplin/node_modules/sqlite3").verbose();
const db = new s.Database(process.env.JOPLIN_DB_PATH, s.OPEN_READONLY, (err) => {
  if (err) { console.error(err.message); process.exit(1); }
  db.run("PRAGMA busy_timeout = 10000", (pe) => {
    if (pe) { console.error(pe.message); process.exit(1); }
    const sql = "SELECT " +
      "(SELECT count(*) FROM notes WHERE length(encryption_cipher_text) > 0) + " +
      "(SELECT count(*) FROM folders WHERE length(encryption_cipher_text) > 0) + " +
      "(SELECT count(*) FROM resources WHERE length(encryption_cipher_text) > 0) + " +
      "(SELECT count(*) FROM tags WHERE length(encryption_cipher_text) > 0) + " +
      "(SELECT count(*) FROM note_tags WHERE length(encryption_cipher_text) > 0) + " +
      "(SELECT count(*) FROM revisions WHERE length(encryption_cipher_text) > 0) AS n";
    db.get(sql, (e, row) => {
      if (e) { console.error(e.message); process.exit(1); }
      console.log(row.n);
      db.close();
    });
  });
});'
    # The :- default keeps the exported form usable if JOPLIN_PROFILE_DIR is
    # not inherited (mirrors the entrypoint's own declaration default).
    local e2ee_state_db_path="${JOPLIN_PROFILE_DIR:-/home/joplin/.config/joplin}/database.sqlite"

    local enc_count
    enc_count=$(JOPLIN_DB_PATH="${e2ee_state_db_path}" flock -w 60 "${SYNC_LOCK_FILE}" node -e "${e2ee_state_probe_script}" 2>>"${LOG_DIR}/e2ee-decrypt-stderr.log") || enc_count=""
    # The count is validated as a plain non-negative integer before any
    # numeric use (`case`, like the M2-T1 verification gate): a failed probe
    # or garbage output cannot produce an "integer expression expected" error
    # and falls through to the fail-closed arm.
    case "${enc_count}" in
        0)
            log "INFO" "[${label}] E2EE state check passed; 0 encrypted items remaining"
            return 0
            ;;
        ''|*[!0-9]*)
            log "ERROR" "[${label}] E2EE state check failed: encrypted-item count probe failed or returned a non-integer — refusing to start periodic sync (issue #29)"
            log "ERROR" "[${label}] Remove ${SYNC_HALT_MARKER} after investigating"
            echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [E2EE_DECRYPT_INCOMPLETE] verification probe failed (redundant post-decrypt check). See issue #29." > "${SYNC_HALT_MARKER}"
            return 2
            ;;
        *)
            log "ERROR" "[${label}] E2EE state check failed: ${enc_count} item(s) still encrypted after decrypt (issue #29)"
            log "ERROR" "[${label}] Remove ${SYNC_HALT_MARKER} after investigating"
            echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') [E2EE_DECRYPT_INCOMPLETE] ${enc_count} item(s) still encrypted (redundant post-decrypt check). See issue #29." > "${SYNC_HALT_MARKER}"
            return 2
            ;;
    esac
}

# --- Copy check_deletion_circuit_breaker() exactly from entrypoint-combined.sh ---
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

    # Suspicious-zero guard for the PRE count: `joplin ls` can fail silently
    # (exit 0, empty output) in either direction. A pre-count of 0 combined with
    # a post-count of 0 would compute deleted = 0 and pass the breaker while a
    # full wipe happened. Retry once; if still 0, skip — the breaker can only
    # compare like-for-like trusted measurements, and skipping is the safe default.
    if [ "${pre_count}" -eq 0 ]; then
        log "WARN" "[${label}] Pre-sync count is 0 — suspicious (possible joplin ls failure); cannot verify baseline, skipping deletion circuit-breaker check"
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

# --- Test harness ---
TEST_DIR="$(mktemp -d)"
export LOG_DIR="${TEST_DIR}"
export JOPLIN_LOG_FILE="${TEST_DIR}/log.txt"
export SYNC_LOCK_FILE="${TEST_DIR}/.sync-flock"
export SYNC_HALT_MARKER="${TEST_DIR}/.sync-halt"
export SYNC_MAX_DELETE_COUNT=100
export JOPLIN_STUB_OUTPUT="${TEST_DIR}/joplin-stub-output"
MOCK_DIR="${TEST_DIR}/mock-bin"
mkdir -p "${MOCK_DIR}"

# Create joplin stub that reads output from JOPLIN_STUB_OUTPUT
cat > "${MOCK_DIR}/joplin" << 'STUB'
#!/bin/bash
if [ -f "${JOPLIN_STUB_OUTPUT}" ]; then
    cat "${JOPLIN_STUB_OUTPUT}"
fi
STUB
chmod +x "${MOCK_DIR}/joplin"

# Create node stub for check_e2ee_state()'s SQLite probe (M2-T3): emits the
# count from JOPLIN_NODE_STUB_OUTPUT, honours JOPLIN_NODE_FAIL=1 (probe
# crash), counts invocations in JOPLIN_NODE_CALLS. The local `joplin` CLI
# path is irrelevant here — the real node probe is covered by the container
# build; these tests exercise the shell contract around the probe.
export JOPLIN_NODE_STUB_OUTPUT="${TEST_DIR}/node-stub-output"
export JOPLIN_NODE_CALLS="${TEST_DIR}/node-stub-calls"
: > "${JOPLIN_NODE_CALLS}"
cat > "${MOCK_DIR}/node" << 'STUB'
#!/bin/bash
n=$(cat "${JOPLIN_NODE_CALLS}" 2>/dev/null || echo 0)
echo $((n + 1)) > "${JOPLIN_NODE_CALLS}"
if [ "${JOPLIN_NODE_FAIL:-0}" = "1" ]; then
    echo "stub node failure" >&2
    exit 1
fi
if [ -f "${JOPLIN_NODE_STUB_OUTPUT}" ]; then
    cat "${JOPLIN_NODE_STUB_OUTPUT}"
fi
STUB
chmod +x "${MOCK_DIR}/node"

# Prepend mock dir to PATH so the stub is found before real joplin
export PATH="${MOCK_DIR}:${PATH}"

PASS_COUNT=0
FAIL_COUNT=0

cleanup() { rm -rf "${TEST_DIR}"; }
trap cleanup EXIT

run_test() {
    local name="$1"
    local expected="$2"
    shift 2

    # Run the function; capture return code
    local rc=0
    check_sync_errors "test-label" "$@" || rc=$?

    if [ "${rc}" -eq "${expected}" ]; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (expected ${expected}, got ${rc})"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

# Helper: remove all log files in LOG_DIR
clean_logs() { rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"; }

# Helper: remove halt marker
clean_halt_marker() { rm -f "${SYNC_HALT_MARKER}"; }

# Helper: set joplin stub output (each line = one "note" or "folder")
set_joplin_stub() { printf '%s\n' "$@" > "${JOPLIN_STUB_OUTPUT}"; }

# --- Test 1: No files exist ---
clean_logs
run_test "No files exist" 0

# --- Test 2: Clean logs ---
clean_logs
echo "All good" > "${JOPLIN_LOG_FILE}"
echo "Sync complete" > "${LOG_DIR}/sync-stdout.log"
: > "${LOG_DIR}/sync-stderr.log"
run_test "Clean logs" 0

# --- Test 3: [error] in log.txt ---
clean_logs
printf '[error] Something failed\n' > "${JOPLIN_LOG_FILE}"
run_test "Error in log.txt" 1

# --- Test 4: Case-insensitive [ERROR] ---
clean_logs
printf '[ERROR] Case test\n' > "${JOPLIN_LOG_FILE}"
run_test "Case-insensitive ERROR in log.txt" 1

# --- Test 5: 'There was some errors' in stdout ---
clean_logs
echo "There was some errors during sync" > "${LOG_DIR}/sync-stdout.log"
run_test "There was some errors in stdout" 1

# --- Test 6: 'Could not encrypt item' in stderr ---
clean_logs
echo "Could not encrypt item" > "${LOG_DIR}/sync-stderr.log"
run_test "Could not encrypt item in stderr" 1

# --- Test 7: 'Master key is not loaded' in log.txt ---
clean_logs
echo "Master key is not loaded" > "${JOPLIN_LOG_FILE}"
run_test "Master key is not loaded in log.txt" 1

# --- Test 8: Error before log_offset (should PASS) ---
clean_logs
printf 'line1\n[error] old error\nline3\n' > "${JOPLIN_LOG_FILE}"
# log_offset=3 means tail from line 3 onward, which skips the [error] on line 2
run_test "Error before log_offset" 0 3

# --- Test 9: Error after log_offset (should FAIL) ---
clean_logs
printf 'line1\nline2\nline3\n[error] new error\n' > "${JOPLIN_LOG_FILE}"
# log_offset=3 means tail from line 3 onward — line 4 has the error
run_test "Error after log_offset" 1 3

# --- Test 10: Error in stdout only ---
clean_logs
echo "[error] stdout error" > "${LOG_DIR}/sync-stdout.log"
run_test "Error in stdout only" 1

# --- Test 11: Error in stderr only ---
clean_logs
echo "[error] stderr error" > "${LOG_DIR}/sync-stderr.log"
run_test "Error in stderr only" 1

# --- Test 12: Unrelated 'error' without brackets (should PASS) ---
clean_logs
echo "This is an error-handling module" > "${JOPLIN_LOG_FILE}"
run_test "Unrelated lowercase error without brackets" 0

# ============================================================================
# Group 2b: expanded combined_pattern tests (M2-T3 Change 1)
# The pattern now also matches the ACTUAL DecryptionWorker wording reported
# in issue #29 ("no master key is currently loaded"), which the old pattern
# missed — the detection blind spot that let the bug ship silently.
# ============================================================================

echo "=== Group 2b: expanded combined_pattern (M2-T3) ==="

# --- Test 12b: the REAL DecryptionWorker log line (issue #29) → detect ---
clean_logs
printf '2026-10-02 10:43:51: e2ee/utils: DecryptionWorker: cannot start because no master key is currently loaded\n' > "${JOPLIN_LOG_FILE}"
run_test "Real DecryptionWorker line (issue #29) detected" 1

# --- Test 12c: 'no master key is currently loaded' alone → detect ---
clean_logs
echo "DecryptionWorker: cannot start because no master key is currently loaded" > "${LOG_DIR}/sync-stderr.log"
run_test "no master key is currently loaded in stderr" 1

# --- Test 12d: bare 'DecryptionWorker' substring → detect (plan-mandated) ---
clean_logs
echo "DecryptionWorker failed" > "${LOG_DIR}/sync-stdout.log"
run_test "Bare DecryptionWorker substring detected" 1

# --- Test 12e: issue #27 regression — destructive pattern still matches ---
clean_logs
echo "Upgrading database from version 0" > "${JOPLIN_LOG_FILE}"
run_test "Issue #27 pattern still matches expanded combined_pattern" 1

# --- Test 12f: clean log without the new alternatives → PASS ---
clean_logs
echo "Sync completed without incidents" > "${JOPLIN_LOG_FILE}"
run_test "Clean log unaffected by expansion" 0

# ============================================================================
# Group 3: check_sync_danger() tests
# ============================================================================

echo "=== Group 3: check_sync_danger() ==="

run_danger_test() {
    local name="$1"
    local expected="$2"
    shift 2

    local rc=0
    check_sync_danger "test-label" "$@" || rc=$?

    if [ "${rc}" -eq "${expected}" ]; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (expected ${expected}, got ${rc})"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

# --- Test 13: SQLITE_BUSY in sync-stdout.log → return 2 ---
clean_logs
echo "SQLITE_BUSY: database is locked" > "${LOG_DIR}/sync-stdout.log"
run_danger_test "SQLITE_BUSY in sync-stdout.log" 2

# --- Test 14: Upgrading database from version 0 in log.txt (with offset) → return 2 ---
clean_logs
printf 'line1\nline2\nUpgrading database from version 0\n' > "${JOPLIN_LOG_FILE}"
run_danger_test "Upgrading database from version 0 in log.txt" 2 1

# --- Test 15: database is locked in sync-stderr.log → return 2 ---
clean_logs
echo "database is locked" > "${LOG_DIR}/sync-stderr.log"
run_danger_test "database is locked in sync-stderr.log" 2

# --- Test 16: Current database version.*null in log.txt → return 2 ---
clean_logs
echo "Current database version is null" > "${JOPLIN_LOG_FILE}"
run_danger_test "Current database version null in log.txt" 2

# --- Test 17: No dangerous patterns → return 0 ---
clean_logs
echo "All good" > "${JOPLIN_LOG_FILE}"
echo "Sync complete" > "${LOG_DIR}/sync-stdout.log"
run_danger_test "No dangerous patterns" 0

# --- Test 18: Missing log files → return 0 (safe default) ---
clean_logs
run_danger_test "Missing log files" 0

# --- Test 19: Dangerous pattern before log_offset → return 0 ---
clean_logs
printf 'line1\nSQLITE_BUSY error\nline3\n' > "${JOPLIN_LOG_FILE}"
# offset=3 means tail from line 3 onward, skipping the SQLITE_BUSY on line 2
run_danger_test "Dangerous pattern before offset" 0 3

echo ""

# ============================================================================
# Group 4: check_deletion_circuit_breaker() tests
# ============================================================================

echo "=== Group 4: check_deletion_circuit_breaker() ==="

run_breaker_test() {
    local name="$1"
    local expected="$2"
    shift 2

    local rc=0
    check_deletion_circuit_breaker "test-label" "$@" || rc=$?

    if [ "${rc}" -eq "${expected}" ]; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (expected ${expected}, got ${rc})"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

# NOTE: get_sync_item_count() calls the stub twice per measurement (once for
# `joplin ls -n 99999`, once for `joplin ls /`) and sums both line counts.
# A static stub listing therefore measures 2x its line count, and the breaker
# takes the post-count itself — the stub must be configured BEFORE the call.
# The real CLI returns notes for the first invocation and folders for the
# second, so summing is correct in production.

# --- Test 20: Deletion count > threshold → return 2, halt marker created ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=5
# Stub listing of 2 lines → measured post-count 4 (2 per invocation);
# pre-count 10 → deleted = 6 > 5 → trip.
set_joplin_stub "note1" "folder1"
run_breaker_test "Deletion exceeds threshold → trip" 2 "10"
if [ -f "${SYNC_HALT_MARKER}" ]; then
    echo "PASS: Halt marker created on trip"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Halt marker not created on trip"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Test 21: Deletion count ≤ threshold → return 0, no marker ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=10
# Stub listing of 3 lines → measured post-count 6; pre-count 10 → deleted = 4 ≤ 10.
set_joplin_stub "n1" "n2" "f1"
run_breaker_test "Deletion within threshold → pass" 0 "10"
if [ ! -f "${SYNC_HALT_MARKER}" ]; then
    echo "PASS: No halt marker when under threshold"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Halt marker created when under threshold"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Test 22: SYNC_MAX_DELETE_COUNT=-1 → return 0 without counting ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=-1
set_joplin_stub "note1"
run_breaker_test "SYNC_MAX_DELETE_COUNT=-1 disables breaker" 0 "1000"

# --- Test 23: Pre-count equals post-count → return 0 ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=10
# Stub listing of 3 lines → measured post-count 6; pre-count 6 → deleted = 0.
set_joplin_stub "n1" "n2" "f1"
run_breaker_test "Pre equals post → pass" 0 "6"

# --- Test 24: Pre-count invalid (skip) → return 1 ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=10
set_joplin_stub "note1"
run_breaker_test "Pre-count=skip → skip" 1 "skip"

# --- Test 25: Pre-count invalid (non-numeric) → return 1 ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=10
set_joplin_stub "note1"
run_breaker_test "Pre-count=non-numeric → skip" 1 "abc"

# --- Test 26: Pre-count empty → return 1 ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=10
set_joplin_stub "note1"
run_breaker_test "Pre-count=empty → skip" 1 ""

# --- Test 27: Failed joplin ls (stub exits 1) → return 1 ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=10
# Override stub to exit 1
cat > "${MOCK_DIR}/joplin" << 'STUB'
#!/bin/bash
exit 1
STUB
chmod +x "${MOCK_DIR}/joplin"
run_breaker_test "Failed joplin ls → skip" 1 "10"
# Restore normal stub
cat > "${MOCK_DIR}/joplin" << 'STUB'
#!/bin/bash
if [ -f "${JOPLIN_STUB_OUTPUT}" ]; then
    cat "${JOPLIN_STUB_OUTPUT}"
fi
STUB
chmod +x "${MOCK_DIR}/joplin"

# --- Test 28: Suspicious zero (post=0, pre>0) → retry, still 0 → return 1 ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=10
# Stub returns empty (0 items) for both pre and post calls
# Pre-count is passed as argument, so pre=5; post will be 0 from stub
: > "${JOPLIN_STUB_OUTPUT}"
run_breaker_test "Suspicious zero (post=0, pre>0) → skip after retry" 1 "5"

# --- Test 29: Suspicious zero → retry succeeds (>0) → normal comparison ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=10
# Stub must report 0 for the first post-count measurement and >0 for the retry.
# get_sync_item_count() invokes the stub twice per measurement, so calls 1-2
# (post attempt) return 0 and calls 3-4 (retry) return 3 lines each → measured
# retry count 6 with pre-count 6 → deleted = 0 ≤ 10 → pass.
STUB_COUNTER_FILE="${TEST_DIR}/stub-counter"
export STUB_COUNTER_FILE
echo "0" > "${STUB_COUNTER_FILE}"
cat > "${MOCK_DIR}/joplin" << 'STUB'
#!/bin/bash
count=$(cat "${STUB_COUNTER_FILE}")
count=$((count + 1))
echo "${count}" > "${STUB_COUNTER_FILE}"
if [ "${count}" -le 2 ]; then
    exit 0
else
    printf 'n1\nf1\nf2\n'
fi
STUB
chmod +x "${MOCK_DIR}/joplin"
run_breaker_test "Suspicious zero → retry succeeds → pass" 0 "6"
# Restore normal stub
cat > "${MOCK_DIR}/joplin" << 'STUB'
#!/bin/bash
if [ -f "${JOPLIN_STUB_OUTPUT}" ]; then
    cat "${JOPLIN_STUB_OUTPUT}"
fi
STUB
chmod +x "${MOCK_DIR}/joplin"

# --- Test 30: SYNC_MAX_DELETE_COUNT=0 → any deletion trips ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=0
# Stub listing of 1 line → measured post-count 2; pre-count 4 → deleted = 2 > 0.
set_joplin_stub "note1"
run_breaker_test "Threshold 0, deleted 2 → trip" 2 "4"

# --- Test 31: Pre-count 0, stub empty → return 1 (skip) ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=10
: > "${JOPLIN_STUB_OUTPUT}"
run_breaker_test "Pre-count=0 (empty stub) → skip" 1 "0"

# --- Test 32: Pre-count 0, post-count > 0 → return 1 (skip; guard is unconditional) ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=10
set_joplin_stub "note1" "folder1" "folder2"
run_breaker_test "Pre-count=0, post>0 → skip" 1 "0"

# --- Test 33: Pre-count 0, SYNC_MAX_DELETE_COUNT=-1 → return 0 (disabled before guard) ---
clean_halt_marker
SYNC_MAX_DELETE_COUNT=-1
: > "${JOPLIN_STUB_OUTPUT}"
run_breaker_test "Pre-count=0, breaker disabled → pass" 0 "0"

# ============================================================================
# Group 5: check_e2ee_state() tests (M2-T3 Change 2)
# Return-code contract: 0 = PASS, 1 = SKIP-WARN (reserved, not produced),
# 2 = TRIP (writes [E2EE_DECRYPT_INCOMPLETE] halt marker). Fail-closed by
# design: a failed/garbage probe TRIPS (plan amendment 2026-10-04), it does
# not skip. The probe runs via the node stub; the marker file assertions
# verify the D4 read side keeps mapping the tag to issue #29.
# ============================================================================

echo "=== Group 5: check_e2ee_state() ==="

run_e2ee_test() {
    local name="$1"
    local expected="$2"

    local rc=0
    check_e2ee_state "test-label" || rc=$?

    if [ "${rc}" -eq "${expected}" ]; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (expected ${expected}, got ${rc})"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

set_node_stub() { printf '%s\n' "$@" > "${JOPLIN_NODE_STUB_OUTPUT}"; }

# --- Test 34: JOPLIN_MASTER_PASSWORD unset → return 0 without probing ---
clean_halt_marker
unset JOPLIN_MASTER_PASSWORD
set_node_stub "5"
: > "${JOPLIN_NODE_CALLS}"
run_e2ee_test "Password unset → pass" 0
NODE_CALLS_READ="$(cat "${JOPLIN_NODE_CALLS}")"
if [ "${NODE_CALLS_READ:-0}" = "0" ]; then
    echo "PASS: Password unset → probe not invoked"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Password unset → probe unexpectedly invoked (${NODE_CALLS_READ} calls)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Test 35: 0 encrypted items → return 0, no marker ---
clean_halt_marker
JOPLIN_MASTER_PASSWORD="test-password"
set_node_stub "0"
run_e2ee_test "0 encrypted items → pass" 0
if [ ! -f "${SYNC_HALT_MARKER}" ]; then
    echo "PASS: 0 encrypted items → no halt marker"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: 0 encrypted items → unexpected halt marker"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Test 36: N encrypted items remain → return 2 + [E2EE_DECRYPT_INCOMPLETE] marker ---
clean_halt_marker
set_node_stub "204"
run_e2ee_test "204 encrypted items → trip" 2
if [ -f "${SYNC_HALT_MARKER}" ] && grep -q "E2EE_DECRYPT_INCOMPLETE" "${SYNC_HALT_MARKER}" && grep -q "204" "${SYNC_HALT_MARKER}"; then
    echo "PASS: 204 encrypted items → marker written with tag and count"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: 204 encrypted items → marker missing or lacks tag/count"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Test 37: probe returns garbage → fail-closed TRIP (not skip) ---
clean_halt_marker
set_node_stub "n/a"
run_e2ee_test "Probe garbage → fail-closed trip" 2
if [ -f "${SYNC_HALT_MARKER}" ] && grep -q "probe failed" "${SYNC_HALT_MARKER}"; then
    echo "PASS: Probe garbage → probe-failed marker written"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Probe garbage → probe-failed marker missing"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Test 38: probe produces empty output → fail-closed TRIP ---
clean_halt_marker
: > "${JOPLIN_NODE_STUB_OUTPUT}"
run_e2ee_test "Probe empty output → fail-closed trip" 2

# --- Test 39: probe crashes (exit 1) → fail-closed TRIP ---
clean_halt_marker
export JOPLIN_NODE_FAIL=1
run_e2ee_test "Probe crash → fail-closed trip" 2
unset JOPLIN_NODE_FAIL
clean_halt_marker

# --- Test 40: check_e2ee_state is in the entrypoint's export -f list ---
# Plan §6: the function must be reachable from the periodic-loop subshell.
# This harness copies functions rather than sourcing the entrypoint, so pin
# the export list textually (same structural-grep pragmatism as the
# preflight harness's Group 0 anti-drift greps).
ENTRYPOINT_FILE="${SCRIPT_DIR}/../entrypoint-combined.sh"
if [ -f "${ENTRYPOINT_FILE}" ] && grep -q "export -f log log_sync halt_marker_tag halt_marker_issue log_halt_marker_refusal halt_marker_issue_note check_sync_errors check_sync_danger get_sync_item_count check_deletion_circuit_breaker check_e2ee_state" "${ENTRYPOINT_FILE}"; then
    echo "PASS: check_e2ee_state present in export -f list"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: check_e2ee_state missing from export -f list"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# ============================================================================
# Group 6: decrypt_stderr_summary() tests (M2-T3 / backlog §5 F1a)
# Never fails; flattens the last 2 stderr lines to one space-separated line
# capped at 300 chars; empty for a missing log.
# ============================================================================

echo "=== Group 6: decrypt_stderr_summary() ==="

# --- Test 40: missing log → empty output, exit 0 ---
rm -f "${LOG_DIR}/e2ee-decrypt-stderr.log"
SUMMARY="$(decrypt_stderr_summary)"
SUMMARY_RC=$?
if [ "${SUMMARY_RC}" -eq 0 ] && [ -z "${SUMMARY}" ]; then
    echo "PASS: Missing log → empty summary"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Missing log → rc=${SUMMARY_RC}, summary='${SUMMARY}'"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Test 41: 3 lines → last 2 kept, flattened (no newline) ---
printf 'line-one error detail\nline-two error detail\nline-three error detail\n' > "${LOG_DIR}/e2ee-decrypt-stderr.log"
SUMMARY="$(decrypt_stderr_summary)"
if [ -n "${SUMMARY}" ] && [ "$(printf '%s' "${SUMMARY}" | wc -l)" -le 1 ] \
    && [[ "${SUMMARY}" == *"line-two error detail"* ]] \
    && [[ "${SUMMARY}" == *"line-three error detail"* ]] \
    && [[ "${SUMMARY}" != *"line-one"* ]]; then
    echo "PASS: Tail keeps last 2 lines flattened"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Tail output unexpected: '${SUMMARY}'"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Test 42: very long line → capped at 300 chars ---
printf 'x%.0s' $(seq 1 1000) > "${LOG_DIR}/e2ee-decrypt-stderr.log"
SUMMARY="$(decrypt_stderr_summary)"
if [ "${#SUMMARY}" -le 301 ] && [ -n "${SUMMARY}" ]; then
    echo "PASS: Long line capped (${#SUMMARY} chars ≤ 301 incl. tr space)"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Long line not capped (${#SUMMARY} chars)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
rm -f "${LOG_DIR}/e2ee-decrypt-stderr.log"

# --- Summary ---
echo ""
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo "Results: ${PASS_COUNT}/${TOTAL} tests passed"
if [ "${FAIL_COUNT}" -gt 0 ]; then
    echo "SOME TESTS FAILED"
    exit 1
fi
echo "ALL TESTS PASSED"
exit 0
