#!/usr/bin/env bash
# Unit tests for check_sync_errors() function from entrypoint-combined.sh
set -euo pipefail

# --- Stub log functions (suppress output) ---
log() { :; }
log_sync() { :; }

# --- Joplin profile / log path (mirrors entrypoint-combined.sh) ---
JOPLIN_PROFILE_DIR="${JOPLIN_PROFILE_DIR:-/home/joplin/.config/joplin}"
JOPLIN_LOG_FILE="${JOPLIN_PROFILE_DIR}/log.txt"

# --- Copy check_sync_errors() exactly from entrypoint-combined.sh (lines 69-108) ---
check_sync_errors() {
    local label="$1"
    local log_offset="${2:-0}"
    local combined_pattern='\[error\]|There was some errors|Could not encrypt item|Master key is not loaded|SQLITE_BUSY|database is locked|Upgrading database from version 0|Current database version.*null'

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
