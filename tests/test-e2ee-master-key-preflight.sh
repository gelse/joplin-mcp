#!/usr/bin/env bash
# Unit tests for the D3 E2EE master-key preflight in entrypoint-combined.sh
#
# Covers backlog decision D3 ("no silent fails"): with JOPLIN_MASTER_PASSWORD
# set but E2EE fully DISABLED on the server (zero master keys after the
# initial sync), `joplin e2ee decrypt` deterministically fails on every
# attempt. The preflight must:
#   - halt BEFORE the bounded retry loop (retry budget NOT burned),
#   - write the dedicated [E2EE_NO_MASTER_KEY] halt marker naming the cause,
#   - set START_PERIODIC_LOOP=0 (never a silent pass),
# and the healthy path (master keys present) must NOT be broken by the
# preflight (no false halt). A failed/unparseable probe must fall through to
# the pre-existing fail-closed retry loop, never false-halt.
#
# The whole M2-T1 block is extracted VERBATIM from entrypoint-combined.sh
# and sourced with stubbed `node`, `flock`, `sleep`, and `log` — the same
# real-block technique as Group 4 of tests/test-final-sync-danger-check.sh
# (catches control-flow drift that function copies cannot).
set -euo pipefail

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="${SCRIPT_DIR}/../entrypoint-combined.sh"

# --- Test harness ---
TEST_DIR="$(mktemp -d)"
LOG_DIR="${TEST_DIR}/log"
JOPLIN_PROFILE_DIR="${TEST_DIR}/profile"
SYNC_HALT_MARKER="${TEST_DIR}/.sync-halt"
# shellcheck disable=SC2034  # SYNC_LOCK_FILE is consumed by the sourced M2-T1 block
SYNC_LOCK_FILE="${TEST_DIR}/.sync-flock"
CAPTURE="${TEST_DIR}/capture.log"
MK_COUNT_FILE="${TEST_DIR}/mk-count"
REMAINING_FILE="${TEST_DIR}/remaining"
FLOCK_MODE_FILE="${TEST_DIR}/flock-mode"
BLOCK_FILE="${TEST_DIR}/m2t1-block.sh"
mkdir -p "${LOG_DIR}" "${JOPLIN_PROFILE_DIR}"

PASS_COUNT=0
FAIL_COUNT=0

cleanup() { rm -rf "${TEST_DIR}"; }
trap cleanup EXIT

assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [ "${expected}" = "${actual}" ]; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (expected '${expected}', got '${actual}')"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

assert_marker_contains() {
    local name="$1" pattern="$2"
    if [ -f "${SYNC_HALT_MARKER}" ] && grep -q "${pattern}" "${SYNC_HALT_MARKER}"; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (marker missing or lacking '${pattern}')"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

assert_marker_absent() {
    local name="$1"
    if [ ! -f "${SYNC_HALT_MARKER}" ]; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (unexpected halt marker: $(cat "${SYNC_HALT_MARKER}"))"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

assert_capture_contains() {
    local name="$1" pattern="$2"
    if grep -q "${pattern}" "${CAPTURE}"; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (capture lacks '${pattern}')"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

assert_capture_not_contains() {
    local name="$1" pattern="$2"
    if grep -q "${pattern}" "${CAPTURE}"; then
        echo "FAIL: ${name} (capture unexpectedly contains '${pattern}')"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    else
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    fi
}

# --- Stub log functions (capture for assertions) ---
log() { printf '%s\n' "$2" >> "${CAPTURE}"; }
log_sync() { printf '%s\n' "$2" >> "${CAPTURE}"; }

# --- Stub sleep (the retry backoff must not slow the tests) ---
sleep() { :; }

# --- Stub flock (records invocation count; exit code from FLOCK_MODE_FILE) ---
flock() {
    FLOCK_CALLS=$((FLOCK_CALLS + 1))
    case "$(cat "${FLOCK_MODE_FILE}" 2>/dev/null || echo fail)" in
        success) return 0 ;;
        *) return 1 ;;
    esac
}

# --- Stub node (routes by probe script content, like the real probes) ---
node() {
    NODE_CALLS=$((NODE_CALLS + 1))
    local script=""
    if [ "${1:-}" = "-e" ]; then
        script="${2:-}"
    fi
    case "${script}" in
        *syncInfoCache*)
            # D3 master-key preflight probe
            if [ -f "${MK_COUNT_FILE}" ]; then
                cat "${MK_COUNT_FILE}"
                return 0
            fi
            echo "stub: master-key probe failure" >&2
            return 1
            ;;
        *encryption_cipher_text*)
            # REMAINING_ENC verification probe
            cat "${REMAINING_FILE}"
            return 0
            ;;
        *)
            echo "stub: unexpected node invocation" >&2
            return 1
            ;;
    esac
}

# --- Extract the M2-T1 block verbatim from entrypoint-combined.sh ---
extract_m2t1_block() {
    awk 'index($0, "# ----- M2-T1: post-sync E2EE decrypt + verification gate (A) -----") { inblock = 1 }
         inblock { print }
         inblock && index($0, "# ----- end M2-T1 block -----") { exit }' "$1"
}

extract_m2t1_block "${ENTRYPOINT}" > "${BLOCK_FILE}"

# Anti-drift gates: the extraction must have captured the real block.
echo "=== Group 0: extraction sanity ==="
if grep -q "E2EE_NO_MASTER_KEY" "${BLOCK_FILE}"; then
    echo "PASS: Extracted block contains the new marker tag"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Extracted block missing the new marker tag — extraction is stale"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if grep -q "Running post-sync E2EE decrypt" "${BLOCK_FILE}"; then
    echo "PASS: Extracted block contains the retry loop"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Extracted block missing the retry loop — extraction is stale"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if grep -q "SELECT value FROM settings WHERE key = ?" "${BLOCK_FILE}" && grep -q "syncInfoCache" "${BLOCK_FILE}"; then
    echo "PASS: Extracted block contains the master-key probe"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Extracted block missing the master-key probe"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
# Ordering: the preflight must run BEFORE the retry loop (line numbers).
MK_LINE=$(grep -n "E2EE_MK_PROBE_SCRIPT=" "${BLOCK_FILE}" | head -1 | cut -d: -f1)
LOOP_LINE=$(grep -n "Running post-sync E2EE decrypt" "${BLOCK_FILE}" | head -1 | cut -d: -f1)
if [ -n "${MK_LINE}" ] && [ -n "${LOOP_LINE}" ] && [ "${MK_LINE}" -lt "${LOOP_LINE}" ]; then
    echo "PASS: Preflight precedes the retry loop"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Preflight does not precede the retry loop (mk=${MK_LINE}, loop=${LOOP_LINE})"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo ""
echo "=== Group 1: inconsistent configuration (password set, no master key) ==="

# --- Test: 0 master keys → [E2EE_NO_MASTER_KEY] halt, retry loop NOT entered ---
# shellcheck disable=SC2034  # JOPLIN_MASTER_PASSWORD is consumed by the sourced M2-T1 block
JOPLIN_MASTER_PASSWORD="test-password"
echo "0" > "${MK_COUNT_FILE}"
echo "0" > "${REMAINING_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
START_PERIODIC_LOOP=1
FLOCK_CALLS=0
NODE_CALLS=0
rm -f "${SYNC_HALT_MARKER}"
: > "${CAPTURE}"
# shellcheck disable=SC1090
source "${BLOCK_FILE}"
assert_marker_contains "0 keys → [E2EE_NO_MASTER_KEY] marker written" "E2EE_NO_MASTER_KEY"
assert_capture_contains "0 keys → ERROR names the inconsistent configuration" "E2EE configuration inconsistent"
assert_eq "0 keys → START_PERIODIC_LOOP ends 0 (halt, never skip)" "0" "${START_PERIODIC_LOOP}"
assert_eq "0 keys → retry loop NOT entered (flock calls)" "0" "${FLOCK_CALLS}"
assert_capture_not_contains "0 keys → no decrypt attempts logged" "Running post-sync E2EE decrypt"

echo ""
echo "=== Group 2: healthy path (master keys present) is NOT broken ==="

# --- Test: 3 master keys, decrypt succeeds, 0 remaining → no halt, loop runs ---
echo "3" > "${MK_COUNT_FILE}"
echo "0" > "${REMAINING_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
START_PERIODIC_LOOP=1
FLOCK_CALLS=0
NODE_CALLS=0
rm -f "${SYNC_HALT_MARKER}"
: > "${CAPTURE}"
# shellcheck disable=SC1090
source "${BLOCK_FILE}"
assert_marker_absent "3 keys + decrypt OK → no halt marker"
assert_eq "3 keys + decrypt OK → START_PERIODIC_LOOP stays 1" "1" "${START_PERIODIC_LOOP}"
assert_eq "3 keys + decrypt OK → retry loop entered exactly once" "1" "${FLOCK_CALLS}"
assert_capture_contains "3 keys → preflight INFO logged" "master-key preflight passed"
assert_capture_contains "3 keys + decrypt OK → completion logged" "0 encrypted items remaining"

echo ""
echo "=== Group 3: probe failure falls through (no false halt, still fail-closed) ==="

# --- Test: probe crashes (nonzero exit, no output) → fall through to retry ---
rm -f "${MK_COUNT_FILE}"
echo "0" > "${REMAINING_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
START_PERIODIC_LOOP=1
FLOCK_CALLS=0
NODE_CALLS=0
rm -f "${SYNC_HALT_MARKER}"
: > "${CAPTURE}"
# shellcheck disable=SC1090
source "${BLOCK_FILE}"
assert_marker_absent "probe crash → NO [E2EE_NO_MASTER_KEY] false halt"
assert_eq "probe crash → retry loop entered (fall-through)" "1" "${FLOCK_CALLS}"
assert_eq "probe crash + decrypt OK → START_PERIODIC_LOOP stays 1" "1" "${START_PERIODIC_LOOP}"
assert_capture_contains "probe crash → WARN logged (no silent fallback)" "cannot confirm master-key presence"

# --- Test: probe returns garbage (non-integer) → fall through to retry ---
echo "n/a" > "${MK_COUNT_FILE}"
echo "0" > "${REMAINING_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
START_PERIODIC_LOOP=1
FLOCK_CALLS=0
NODE_CALLS=0
rm -f "${SYNC_HALT_MARKER}"
: > "${CAPTURE}"
# shellcheck disable=SC1090
source "${BLOCK_FILE}"
assert_marker_absent "probe garbage → NO [E2EE_NO_MASTER_KEY] false halt"
assert_eq "probe garbage → retry loop entered (fall-through)" "1" "${FLOCK_CALLS}"
assert_eq "probe garbage + decrypt OK → START_PERIODIC_LOOP stays 1" "1" "${START_PERIODIC_LOOP}"

echo ""
echo "=== Group 4: pre-existing fail-closed paths preserved ==="

# --- Test: 1 master key, decrypt always fails → 4 attempts, [E2EE_DECRYPT_FAIL] ---
echo "1" > "${MK_COUNT_FILE}"
echo "0" > "${REMAINING_FILE}"
echo "fail" > "${FLOCK_MODE_FILE}"
START_PERIODIC_LOOP=1
FLOCK_CALLS=0
NODE_CALLS=0
rm -f "${SYNC_HALT_MARKER}"
: > "${CAPTURE}"
# shellcheck disable=SC1090
source "${BLOCK_FILE}"
assert_eq "1 key + decrypt fails → retry budget intact (4 attempts)" "4" "${FLOCK_CALLS}"
assert_marker_contains "1 key + decrypt fails → [E2EE_DECRYPT_FAIL] marker" "E2EE_DECRYPT_FAIL"
assert_eq "1 key + decrypt fails → START_PERIODIC_LOOP ends 0" "0" "${START_PERIODIC_LOOP}"
assert_capture_not_contains "decrypt-fail path never emits the new marker" "E2EE_NO_MASTER_KEY"

# --- Test: verification finds remaining encrypted items → [E2EE_DECRYPT_INCOMPLETE] ---
echo "1" > "${MK_COUNT_FILE}"
echo "7" > "${REMAINING_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
START_PERIODIC_LOOP=1
FLOCK_CALLS=0
rm -f "${SYNC_HALT_MARKER}"
: > "${CAPTURE}"
# shellcheck disable=SC1090
source "${BLOCK_FILE}"
assert_marker_contains "7 remaining → [E2EE_DECRYPT_INCOMPLETE] marker" "E2EE_DECRYPT_INCOMPLETE"
assert_eq "7 remaining → START_PERIODIC_LOOP ends 0" "0" "${START_PERIODIC_LOOP}"

echo ""
echo "=== Group 5: no master password → block is a no-op (Risk #1 guard intact) ==="

# --- Test: JOPLIN_MASTER_PASSWORD unset → no probe, no retry, no marker ---
unset JOPLIN_MASTER_PASSWORD
echo "0" > "${MK_COUNT_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
START_PERIODIC_LOOP=1
FLOCK_CALLS=0
NODE_CALLS=0
rm -f "${SYNC_HALT_MARKER}"
: > "${CAPTURE}"
# shellcheck disable=SC1090
source "${BLOCK_FILE}"
assert_marker_absent "no password → no halt marker"
assert_eq "no password → START_PERIODIC_LOOP stays 1" "1" "${START_PERIODIC_LOOP}"
assert_eq "no password → preflight not run (node calls)" "0" "${NODE_CALLS}"
assert_eq "no password → retry not run (flock calls)" "0" "${FLOCK_CALLS}"

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
