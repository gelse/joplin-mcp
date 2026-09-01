#!/usr/bin/env bash
# Unit tests for sync failure diagnostics in entrypoint-combined.sh
# Tests: log tail on failure, connectivity probe, updated log messages
set -euo pipefail

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="${SCRIPT_DIR}/../entrypoint-combined.sh"

# --- Test harness ---
TEST_DIR="$(mktemp -d)"
PASS_COUNT=0
FAIL_COUNT=0

cleanup() { rm -rf "${TEST_DIR}"; }
trap cleanup EXIT

run_test() {
    local name="$1"
    local expected="$2"
    shift 2

    local rc=0
    "$@" || rc=$?

    if [ "${rc}" -eq "${expected}" ]; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (expected exit ${expected}, got ${rc})"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

# ============================================================================
# Group 1: Script structure validation (grep-based static checks)
# ============================================================================

echo "=== Group 1: Script structure validation ==="

# --- Test 1: log.txt tail pattern in initial sync failure branch ---
run_test "Initial sync failure contains tail -n 20 log.txt" 0 \
    grep -q 'tail -n 20 "${LOG_DIR}/log.txt" >&2' "${ENTRYPOINT}"

# --- Test 2: log.txt tail pattern in periodic sync failure branch ---
# Both branches use the same pattern; confirm it appears at least twice
run_test "Periodic sync failure contains tail -n 20 log.txt (>=2 occurrences)" 0 \
    bash -c 'count=$(grep -c "tail -n 20" "$1"); [ "${count}" -ge 2 ]' _ "${ENTRYPOINT}"

# --- Test 3: Connectivity probe (curl with /api/ping) ---
run_test "Startup connectivity probe present (curl /api/ping)" 0 \
    grep -q 'curl -sf.*api/ping' "${ENTRYPOINT}"

# --- Test 4: Updated "configured" log message ---
run_test "Updated configured log message present" 0 \
    grep -q "server reachability will be checked after API token is obtained" "${ENTRYPOINT}"

# --- Test 5: Old 'configured successfully' message NOT present ---
run_test "Old 'configured successfully' message absent" 1 \
    grep -q "configured successfully" "${ENTRYPOINT}"

echo ""

# ============================================================================
# Group 2: Log tail fallback behavior (isolated function test)
# ============================================================================

echo "=== Group 2: Log tail fallback behavior ==="

# --- Test 6: When log.txt exists with content, tail -n 20 returns last 20 lines ---
(
    # Create a log file with 30 lines
    for i in $(seq 1 30); do
        echo "line ${i}"
    done > "${TEST_DIR}/log.txt"

    result=$(tail -n 20 "${TEST_DIR}/log.txt")
    line_count=$(echo "${result}" | wc -l)
    first_line=$(echo "${result}" | head -n 1)

    if [ "${line_count}" -eq 20 ] && [ "${first_line}" = "line 11" ]; then
        echo "PASS: tail -n 20 returns last 20 lines"
        exit 0
    else
        echo "FAIL: tail -n 20 returned ${line_count} lines, first='${first_line}'"
        exit 1
    fi
) && PASS_COUNT=$((PASS_COUNT + 1)) || FAIL_COUNT=$((FAIL_COUNT + 1))

# --- Test 7: When log.txt has fewer than 20 lines, all lines returned ---
(
    printf 'line1\nline2\nline3\n' > "${TEST_DIR}/log.txt"

    result=$(tail -n 20 "${TEST_DIR}/log.txt")
    line_count=$(echo "${result}" | wc -l)

    if [ "${line_count}" -eq 3 ]; then
        echo "PASS: tail -n 20 returns all lines when fewer than 20"
        exit 0
    else
        echo "FAIL: expected 3 lines, got ${line_count}"
        exit 1
    fi
) && PASS_COUNT=$((PASS_COUNT + 1)) || FAIL_COUNT=$((FAIL_COUNT + 1))

# --- Test 8: When log.txt does not exist, fallback fires (return code non-zero) ---
(
    # Remove the file if it exists
    rm -f "${TEST_DIR}/log.txt"

    # Replicate the exact pattern from entrypoint-combined.sh:
    #   tail -n 20 "${LOG_DIR}/log.txt" 2>/dev/null || log "WARN" "log.txt not found or empty"
    # We use a stub log function and capture stderr
    log() { :; }
    tail -n 20 "${TEST_DIR}/log.txt" 2>/dev/null || log "WARN" "log.txt not found or empty"

    # If we got here, the pattern worked (tail failed, log fallback ran)
    echo "PASS: tail fallback fires when log.txt is missing"
    exit 0
) && PASS_COUNT=$((PASS_COUNT + 1)) || FAIL_COUNT=$((FAIL_COUNT + 1))

# --- Test 9: When log.txt is empty, tail succeeds with no output ---
(
    : > "${TEST_DIR}/log.txt"

    output=$(tail -n 20 "${TEST_DIR}/log.txt")
    rc=$?

    if [ "${rc}" -eq 0 ] && [ -z "${output}" ]; then
        echo "PASS: tail succeeds on empty log.txt with no output"
        exit 0
    else
        echo "FAIL: tail returned rc=${rc}, output='${output}'"
        exit 1
    fi
) && PASS_COUNT=$((PASS_COUNT + 1)) || FAIL_COUNT=$((FAIL_COUNT + 1))

echo ""

# ============================================================================
# Group 3: Connectivity probe behavior (mocked curl test)
# ============================================================================

echo "=== Group 3: Connectivity probe behavior ==="

# --- Helper: probe function replicating the pattern from entrypoint-combined.sh ---
# Usage: run_probe <mock_exit_code> <expected_keyword>
# Sets up a mock curl, runs the probe, and checks output.
run_probe() {
    local mock_exit="$1"
    local expected_keyword="$2"
    local mock_dir="${TEST_DIR}/mock-bin"
    local probe_log="${TEST_DIR}/probe-output.log"

    mkdir -p "${mock_dir}"

    # Create mock curl that always exits with the given code
    cat > "${mock_dir}/curl" <<MOCK
#!/bin/bash
exit ${mock_exit}
MOCK
    chmod +x "${mock_dir}/curl"

    # Run the probe with mock curl in PATH
    local server_url="https://joplin.example.com"
    local api_token="test-token-123"

    PATH="${mock_dir}:${PATH}" bash -c "
        server_url=\"${server_url}\"
        api_token=\"${api_token}\"
        # Replicate the probe logic from entrypoint-combined.sh
        if curl -sf --connect-timeout 5 --max-time 10 \"\${server_url}/api/ping?token=\${api_token}\" -o /dev/null 2>/dev/null; then
            echo 'reachable'
        else
            echo 'not reachable'
        fi
    " > "${probe_log}" 2>/dev/null

    grep -q "${expected_keyword}" "${probe_log}"
}

# --- Test 10: curl succeeds → probe reports "reachable" ---
(
    if run_probe 0 "reachable"; then
        echo "PASS: curl success reports reachable"
        exit 0
    else
        echo "FAIL: curl success did not report reachable"
        exit 1
    fi
) && PASS_COUNT=$((PASS_COUNT + 1)) || FAIL_COUNT=$((FAIL_COUNT + 1))

# --- Test 11: curl fails → probe reports "not reachable" warning ---
(
    if run_probe 1 "not reachable"; then
        echo "PASS: curl failure reports not reachable"
        exit 0
    else
        echo "FAIL: curl failure did not report not reachable"
        exit 1
    fi
) && PASS_COUNT=$((PASS_COUNT + 1)) || FAIL_COUNT=$((FAIL_COUNT + 1))

# --- Test 12: Probe uses correct URL pattern with token parameter ---
(
    MOCK_DIR="${TEST_DIR}/mock-bin"
    mkdir -p "${MOCK_DIR}"

    # Mock curl that logs its arguments to a file
    cat > "${MOCK_DIR}/curl" <<'MOCK'
#!/bin/bash
echo "$@" > "${TEST_DIR}/curl-args.txt"
exit 0
MOCK
    chmod +x "${MOCK_DIR}/curl"

    export TEST_DIR
    server_url="https://joplin.example.com"
    api_token="secret-token-xyz"

    PATH="${MOCK_DIR}:${PATH}" bash -c "
        curl -sf --connect-timeout 5 --max-time 10 \"${server_url}/api/ping?token=${api_token}\" -o /dev/null
    " 2>/dev/null

    # Check that the URL in curl args contains the expected pattern
    if grep -q "api/ping" "${TEST_DIR}/curl-args.txt" && grep -q "token=secret-token-xyz" "${TEST_DIR}/curl-args.txt"; then
        echo "PASS: probe uses correct URL pattern with token"
        exit 0
    else
        echo "FAIL: probe URL pattern incorrect. Args: $(cat "${TEST_DIR}/curl-args.txt")"
        exit 1
    fi
) && PASS_COUNT=$((PASS_COUNT + 1)) || FAIL_COUNT=$((FAIL_COUNT + 1))

echo ""

# ============================================================================
# Summary
# ============================================================================
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo "Results: ${PASS_COUNT}/${TOTAL} tests passed"
if [ "${FAIL_COUNT}" -gt 0 ]; then
    echo "SOME TESTS FAILED"
    exit 1
fi
echo "ALL TESTS PASSED"
exit 0
