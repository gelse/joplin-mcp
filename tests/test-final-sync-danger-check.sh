#!/usr/bin/env bash
# Test that the final-sync danger check is not vacuous.
#
# Verifies the M5 fix: LOG_TAIL_START must be computed BEFORE the sync runs,
# and sync output must go to sync-stdout.log/sync-stderr.log (not /dev/null).
# This ensures check_sync_danger can detect destructive signatures written by
# the final sync itself.
set -euo pipefail

# --- Stub log functions (suppress output) ---
log() { :; }
log_sync() { :; }

# --- Paths ---
TEST_DIR="$(mktemp -d)"
export LOG_DIR="${TEST_DIR}"
export JOPLIN_LOG_FILE="${TEST_DIR}/log.txt"
export SYNC_LOCK_FILE="${TEST_DIR}/.sync-flock"

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
                log "ERROR" "[${label}] DANGEROUS sync signature detected in ${f}"
                return 2
            fi
        else
            if grep -i -q -E "${dangerous_pattern}" "${f}" 2>/dev/null; then
                log "ERROR" "[${label}] DANGEROUS sync signature detected in ${f}"
                return 2
            fi
        fi
    done
    return 0
}

# --- Test harness ---
PASS_COUNT=0
FAIL_COUNT=0

cleanup() { rm -rf "${TEST_DIR}"; }
trap cleanup EXIT

run_test() {
    local name="$1"
    local expected="$2"
    shift 2

    local rc=0
    check_sync_danger "Final" "$@" || rc=$?

    if [ "${rc}" -eq "${expected}" ]; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (expected ${expected}, got ${rc})"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

# =========================================================================
# Group 1: Correct behavior — LOG_TAIL_START computed BEFORE sync
# =========================================================================
echo "=== Group 1: LOG_TAIL_START before sync (fixed ordering) ==="

# --- Test 1: SQLITE_BUSY in log.txt detected via windowed scan ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'line1\nline2\nline3\n' > "${JOPLIN_LOG_FILE}"
# Simulate: LOG_TAIL_START computed BEFORE sync (line count = 3, so offset = 4)
LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
# Simulate: sync appends SQLITE_BUSY to log.txt
printf 'SQLITE_BUSY: database is locked\n' >> "${JOPLIN_LOG_FILE}"
# check_sync_danger should see the new line via the windowed scan
run_test "SQLITE_BUSY in log.txt detected (before-sync offset)" 2 "${LOG_TAIL_START}"

# --- Test 2: SQLITE_BUSY in sync-stdout.log detected (not /dev/null) ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'line1\nline2\n' > "${JOPLIN_LOG_FILE}"
LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
# Simulate: sync redirects to sync-stdout.log (not /dev/null)
printf 'SQLITE_BUSY: database is locked\n' > "${LOG_DIR}/sync-stdout.log"
run_test "SQLITE_BUSY in sync-stdout.log detected" 2 "${LOG_TAIL_START}"

# --- Test 3: SQLITE_BUSY in sync-stderr.log detected ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'line1\nline2\n' > "${JOPLIN_LOG_FILE}"
LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
printf 'SQLITE_BUSY: database is locked\n' > "${LOG_DIR}/sync-stderr.log"
run_test "SQLITE_BUSY in sync-stderr.log detected" 2 "${LOG_TAIL_START}"

# --- Test 4: "Upgrading database from version 0" in log.txt detected ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'line1\nline2\nline3\nline4\n' > "${JOPLIN_LOG_FILE}"
LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
printf 'Upgrading database from version 0 to 1\n' >> "${JOPLIN_LOG_FILE}"
run_test "Upgrading database in log.txt detected (before-sync offset)" 2 "${LOG_TAIL_START}"

# --- Test 5: No dangerous patterns — clean sync passes ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'line1\nline2\n' > "${JOPLIN_LOG_FILE}"
LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
printf 'Sync complete\n' >> "${JOPLIN_LOG_FILE}"
printf 'Sync complete\n' > "${LOG_DIR}/sync-stdout.log"
: > "${LOG_DIR}/sync-stderr.log"
run_test "Clean sync passes" 0 "${LOG_TAIL_START}"

# --- Test 6: Dangerous pattern BEFORE the window is NOT detected (correct) ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'SQLITE_BUSY: old error\nline2\nline3\n' > "${JOPLIN_LOG_FILE}"
LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
# Sync writes clean output — no new dangerous patterns
printf 'Sync complete\n' >> "${JOPLIN_LOG_FILE}"
run_test "Old SQLITE_BUSY before window not detected" 0 "${LOG_TAIL_START}"

# =========================================================================
# Group 2: Vacuous behavior — LOG_TAIL_START computed AFTER sync (old bug)
# =========================================================================
echo ""
echo "=== Group 2: LOG_TAIL_START after sync (old vacuous ordering — proves the bug) ==="

# --- Test 7: SQLITE_BUSY in log.txt MISSED when offset computed after sync ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'line1\nline2\nline3\n' > "${JOPLIN_LOG_FILE}"
# Simulate OLD behavior: sync runs first, appending SQLITE_BUSY
printf 'SQLITE_BUSY: database is locked\n' >> "${JOPLIN_LOG_FILE}"
# THEN compute LOG_TAIL_START (old bug — points past the SQLITE_BUSY line)
LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
# check_sync_danger scans empty window — returns 0 (vacuous pass)
run_test "SQLITE_BUSY MISSED with after-sync offset (old bug)" 0 "${LOG_TAIL_START}"

# --- Test 8: sync-stdout.log content MISSED when output goes to /dev/null ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'line1\nline2\n' > "${JOPLIN_LOG_FILE}"
LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
# Simulate OLD behavior: sync output discarded to /dev/null, no sync-stdout.log written
# (sync-stdout.log still holds previous sync content or doesn't exist)
# Nothing appended to log.txt either — window is empty
run_test "No sync output file (old /dev/null behavior) — clean" 0 "${LOG_TAIL_START}"

# =========================================================================
# Group 3: End-to-end simulation with stubbed flock
# =========================================================================
echo ""
echo "=== Group 3: End-to-end flock stub simulation ==="

# Create mock flock that runs the command and appends SQLITE_BUSY to log.txt
MOCK_DIR="${TEST_DIR}/mock-bin"
mkdir -p "${MOCK_DIR}"
cat > "${MOCK_DIR}/flock" << 'STUB'
#!/bin/bash
# flock -w 120 LOCKFILE -c 'joplin sync' > ... 2> ...
# Execute the command passed to -c, then simulate destructive output
shift 3  # drop -w 120 LOCKFILE
# The remaining args are -c 'joplin sync' > ... 2> ...
# Find and execute the -c command
while [ $# -gt 0 ]; do
    case "$1" in
        -c)
            shift
            eval "$1"
            shift
            ;;
        *)
            shift
            ;;
    esac
done
# Simulate: joplin sync appended SQLITE_BUSY to log.txt
echo 'SQLITE_BUSY: database is locked' >> "${JOPLIN_LOG_FILE}"
STUB
chmod +x "${MOCK_DIR}/flock"

# Create minimal joplin stub
cat > "${MOCK_DIR}/joplin" << 'STUB'
#!/bin/bash
echo "Sync OK"
STUB
chmod +x "${MOCK_DIR}/joplin"

export PATH="${MOCK_DIR}:${PATH}"

# --- Test 9: Fixed ordering — SQLITE_BUSY detected end-to-end ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'line1\nline2\nline3\n' > "${JOPLIN_LOG_FILE}"
# Fixed ordering: LOG_TAIL_START BEFORE flock sync
LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
SYNC_EXIT=0
flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin sync' > "${LOG_DIR}/sync-stdout.log" 2> "${LOG_DIR}/sync-stderr.log" || SYNC_EXIT=$?
DANGER_RC=0
check_sync_danger "Final" "${LOG_TAIL_START}" || DANGER_RC=$?
if [ "${DANGER_RC}" -eq 2 ]; then
    echo "PASS: End-to-end fixed ordering — SQLITE_BUSY detected"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: End-to-end fixed ordering — expected 2, got ${DANGER_RC}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Test 10: Old ordering — SQLITE_BUSY missed end-to-end ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'line1\nline2\nline3\n' > "${JOPLIN_LOG_FILE}"
# Old ordering: sync FIRST, then compute LOG_TAIL_START
SYNC_EXIT=0
flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin sync' > /dev/null 2>&1 || SYNC_EXIT=$?
# Now compute LOG_TAIL_START (old bug)
LOG_TAIL_START=$(( $(wc -l < "${JOPLIN_LOG_FILE}" 2>/dev/null || echo 0) + 1 ))
DANGER_RC=0
check_sync_danger "Final" "${LOG_TAIL_START}" || DANGER_RC=$?
if [ "${DANGER_RC}" -eq 0 ]; then
    echo "PASS: End-to-end old ordering — SQLITE_BUSY missed (vacuous pass, proves bug)"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: End-to-end old ordering — expected 0, got ${DANGER_RC}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Test 11: Fail branch — sync exits nonzero, exit code logged ---
rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log"
printf 'line1\n' > "${JOPLIN_LOG_FILE}"
# Create a flock stub that exits nonzero
cat > "${MOCK_DIR}/flock" << 'STUB'
#!/bin/bash
while [ $# -gt 0 ]; do
    case "$1" in
        -c) shift; eval "$1"; shift ;;
        *) shift ;;
    esac
done
echo 'Sync failed with error' >&2
exit 1
STUB
chmod +x "${MOCK_DIR}/flock"
SYNC_EXIT=0
flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin sync' > "${LOG_DIR}/sync-stdout.log" 2> "${LOG_DIR}/sync-stderr.log" || SYNC_EXIT=$?
if [ "${SYNC_EXIT}" -ne 0 ]; then
    echo "PASS: Fail branch — sync exit code ${SYNC_EXIT} captured"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Fail branch — expected nonzero, got ${SYNC_EXIT}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# =========================================================================
# Group 4: Real final-sync block extracted verbatim from entrypoint-combined.sh
#
# Regression guard: the previous revision wrapped the sync in
# `if flock ... > log 2> log || SYNC_EXIT=$?; then` — the `|| SYNC_EXIT=$?`
# made the if-condition always true, so a failing sync was reported as
# "completed successfully" and the FAIL branch was unreachable.  These tests
# source the actual block from the script (not a copy) to catch that class of
# control-flow regression.
# =========================================================================
echo ""
echo "=== Group 4: extracted real final-sync block from entrypoint-combined.sh ==="

SCRIPT_PATH="$(cd "$(dirname "$0")/.." && pwd)/entrypoint-combined.sh"
FINAL_BLOCK="${TEST_DIR}/final-sync-block.sh"
SYNC_CAPTURE="${TEST_DIR}/sync-capture.log"

# Extract the block verbatim: from the data_api_alive gate to the first
# 4-space-indented `fi` (the block's own closing fi).
extract_final_block() {
    awk 'index($0, "if [ \"${data_api_alive}\" = true ] && ! [ -f \"${SYNC_HALT_MARKER}\" ]; then") { inblock = 1 }
         inblock { print }
         inblock && /^    fi$/ { exit }' "$1"
}

if [ ! -f "${SCRIPT_PATH}" ]; then
    echo "FAIL: ${SCRIPT_PATH} not found — cannot extract real final-sync block"
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    extract_final_block "${SCRIPT_PATH}" > "${FINAL_BLOCK}"

    if ! grep -q 'Performing final sync before shutdown' "${FINAL_BLOCK}"; then
        echo "FAIL: could not extract final-sync block from ${SCRIPT_PATH}"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    else
        # --- Test 12: real block takes the FAIL branch on nonzero sync exit ---
        rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log" "${SYNC_CAPTURE}"
        printf 'line1\n' > "${JOPLIN_LOG_FILE}"
        cat > "${MOCK_DIR}/flock" << 'STUB'
#!/bin/bash
while [ $# -gt 0 ]; do
    case "$1" in
        -c) shift; eval "$1"; shift ;;
        *) shift ;;
    esac
done
echo 'FATAL: could not acquire lock' >&2
exit 7
STUB
        chmod +x "${MOCK_DIR}/flock"

        run_final_block() {
            data_api_alive=true
            SYNC_HALT_MARKER="${TEST_DIR}/halt"
            LOG_TAIL_START=0
            PRE_SYNC_COUNT=skip
            SYNC_EXIT=0
            log() { printf '%s\n' "$2" >> "${SYNC_CAPTURE}"; }
            log_sync() { printf '%s\n' "$2" >> "${SYNC_CAPTURE}"; }
            get_sync_item_count() { echo 0; }
            check_deletion_circuit_breaker() { return 0; }
            # shellcheck disable=SC1090
            source "${FINAL_BLOCK}"
        }

        BLOCK_RC=0
        ( set -euo pipefail; run_final_block ) || BLOCK_RC=$?
        if [ "${BLOCK_RC}" -eq 0 ] && grep -q 'Final sync failed (exit code: 7)' "${SYNC_CAPTURE}" \
            && ! grep -q 'completed successfully' "${SYNC_CAPTURE}"; then
            echo "PASS: real block — nonzero sync exit reaches FAIL branch"
            PASS_COUNT=$((PASS_COUNT + 1))
        else
            echo "FAIL: real block — nonzero sync exit did NOT reach FAIL branch (rc=${BLOCK_RC})"
            FAIL_COUNT=$((FAIL_COUNT + 1))
        fi

        # --- Test 13: real block reports DANGEROUS on a destructive final sync ---
        rm -f "${JOPLIN_LOG_FILE}" "${LOG_DIR}/sync-stdout.log" "${LOG_DIR}/sync-stderr.log" "${SYNC_CAPTURE}"
        printf 'line1\nline2\nline3\n' > "${JOPLIN_LOG_FILE}"
        cat > "${MOCK_DIR}/flock" << 'STUB'
#!/bin/bash
while [ $# -gt 0 ]; do
    case "$1" in
        -c) shift; eval "$1"; shift ;;
        *) shift ;;
    esac
done
echo 'SQLITE_BUSY: database is locked' >> "${JOPLIN_LOG_FILE}"
exit 0
STUB
        chmod +x "${MOCK_DIR}/flock"

        BLOCK_RC=0
        ( set -euo pipefail; run_final_block ) || BLOCK_RC=$?
        if [ "${BLOCK_RC}" -eq 0 ] \
            && grep -q 'DANGEROUS sync signature detected' "${SYNC_CAPTURE}" \
            && grep -q 'Destructive signature detected in final sync' "${SYNC_CAPTURE}"; then
            echo "PASS: real block — destructive final sync yields [Final] danger detection"
            PASS_COUNT=$((PASS_COUNT + 1))
        else
            echo "FAIL: real block — destructive final sync NOT detected (rc=${BLOCK_RC})"
            FAIL_COUNT=$((FAIL_COUNT + 1))
        fi
    fi
fi

# =========================================================================
# Summary
# =========================================================================
echo ""
echo "Results: $((PASS_COUNT))/${PASS_COUNT}+${FAIL_COUNT} tests passed"
if [ "${FAIL_COUNT}" -gt 0 ]; then
    echo "SOME TESTS FAILED"
    exit 1
fi
echo "ALL TESTS PASSED"
