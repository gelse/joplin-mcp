#!/usr/bin/env bash
# Unit tests for check_sync_errors() function from entrypoint-combined.sh
set -euo pipefail

# --- Stub log functions (suppress output) ---
log() { :; }
log_sync() { :; }

# --- Joplin profile / log path (mirrors entrypoint-combined.sh) ---
JOPLIN_PROFILE_DIR="${JOPLIN_PROFILE_DIR:-/home/joplin/.config/joplin}"
JOPLIN_LOG_FILE="${JOPLIN_PROFILE_DIR}/log.txt"

# --- Copy check_sync_errors() exactly from entrypoint-combined.sh (lines 66-105) ---
check_sync_errors() {
    local label="$1"
    local log_offset="${2:-0}"
    local combined_pattern='\[error\]|There was some errors|Could not encrypt item|Master key is not loaded'

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

# --- Test harness ---
TEST_DIR="$(mktemp -d)"
export LOG_DIR="${TEST_DIR}"
export JOPLIN_LOG_FILE="${TEST_DIR}/log.txt"
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
