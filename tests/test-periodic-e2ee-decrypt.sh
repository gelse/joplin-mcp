#!/usr/bin/env bash
# Unit tests for the periodic-path post-sync E2EE decrypt in entrypoint-combined.sh
#
# Covers issue #29 comment 6072403277: with JOPLIN_MASTER_PASSWORD set, items
# added remotely AFTER boot reach the container only via the PERIODIC sync
# loop — which never decrypted, so they stayed encrypted until the operator
# ran `joplin e2ee decrypt` by hand. The loop body must now call
# run_periodic_e2ee_decrypt after every successful periodic sync, and the
# helper must:
#   - no-op entirely without JOPLIN_MASTER_PASSWORD (non-E2EE deployments
#     pay neither the probe cost nor the retry budget),
#   - skip the doomed decrypt when the preflight counts 0 master keys
#     (deterministic DecryptionWorker failure) WITHOUT halting,
#   - retry the decrypt 4×5 s like the boot block (with --force),
#   - verify zero remaining encrypted items via the SQLite gate,
#   - on persistent failure log [SYNC_FAIL] and return nonzero but NEVER
#     write the halt marker and NEVER touch START_PERIODIC_LOOP — the loop
#     continues; halt semantics in the loop are M13's scope.
#
# The whole periodic-E2EE block is extracted VERBATIM from
# entrypoint-combined.sh (between its begin/end markers) and the defined
# function is exercised with stubbed `node`, `flock`, `sleep`, and log
# functions — the same real-block technique as
# tests/test-e2ee-master-key-preflight.sh.
set -euo pipefail

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="${SCRIPT_DIR}/../entrypoint-combined.sh"

# --- Test harness ---
TEST_DIR="$(mktemp -d)"
LOG_DIR="${TEST_DIR}/log"
JOPLIN_PROFILE_DIR="${TEST_DIR}/profile"
SYNC_HALT_MARKER="${TEST_DIR}/.sync-halt"
# shellcheck disable=SC2034  # SYNC_LOCK_FILE is consumed by the extracted block
SYNC_LOCK_FILE="${TEST_DIR}/.sync-flock"
CAPTURE="${TEST_DIR}/capture.log"
MK_COUNT_FILE="${TEST_DIR}/mk-count"
REMAINING_FILE="${TEST_DIR}/remaining"
FLOCK_MODE_FILE="${TEST_DIR}/flock-mode"
BLOCK_FILE="${TEST_DIR}/periodic-e2ee-block.sh"
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

# --- Stub log functions (capture for assertions) ---
log() { printf '%s\n' "$2" >> "${CAPTURE}"; }
log_sync() { printf '%s\n' "[SYNC_$1] $2" >> "${CAPTURE}"; }

# --- Stub sleep (the retry backoff must not slow the tests) ---
sleep() { :; }

# --- Stub flock (records invocation count; exit code from FLOCK_MODE_FILE) ---
# shellcheck disable=SC2317  # restored before every sourced-call group
flock() {
    FLOCK_CALLS=$((FLOCK_CALLS + 1))
    case "$(cat "${FLOCK_MODE_FILE}" 2>/dev/null || echo fail)" in
        success) return 0 ;;
        *) return 1 ;;
    esac
}

# --- Stub node (routes by probe script content, like the real probes) ---
# shellcheck disable=SC2317
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

# --- Stub for the shared stderr summarizer (lives outside the block) ---
# shellcheck disable=SC2317
decrypt_stderr_summary() { :; }

# --- Extract the periodic-E2EE block verbatim from entrypoint-combined.sh ---
extract_periodic_block() {
    awk 'index($0, "# ----- periodic-E2EE block begin") { inblock = 1 }
         inblock { print }
         inblock && index($0, "# ----- periodic-E2EE block end -----") { exit }' "$1"
}

extract_periodic_block "${ENTRYPOINT}" > "${BLOCK_FILE}"

echo "=== Group 0: extraction sanity + structural pins ==="
if grep -q "run_periodic_e2ee_decrypt()" "${BLOCK_FILE}"; then
    echo "PASS: Extracted block defines run_periodic_e2ee_decrypt"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Extracted block does not define run_periodic_e2ee_decrypt — extraction is stale"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if grep -q "joplin e2ee decrypt --force" "${BLOCK_FILE}"; then
    echo "PASS: Extracted block passes --force to joplin e2ee decrypt (F1b)"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: joplin e2ee decrypt --force missing from the block (F1b regression)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if grep -q "syncInfoCache" "${BLOCK_FILE}" && grep -q "encryption_cipher_text" "${BLOCK_FILE}"; then
    echo "PASS: Extracted block contains preflight + verification probes"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Extracted block is missing the SQLite probes"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
# Halt semantics: the loop-side helper must NEVER write the marker or touch
# START_PERIODIC_LOOP (that is M13 detect-and-halt scope, not this fix).
if grep -q "SYNC_HALT_MARKER" "${BLOCK_FILE}"; then
    echo "FAIL: Block references SYNC_HALT_MARKER — periodic path must never halt (M13 scope)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS: Block never references SYNC_HALT_MARKER (no halt from the loop)"
    PASS_COUNT=$((PASS_COUNT + 1))
fi
if grep -q "START_PERIODIC_LOOP=" "${BLOCK_FILE}"; then
    echo "FAIL: Block assigns START_PERIODIC_LOOP — periodic path must never halt (M13 scope)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS: Block never assigns START_PERIODIC_LOOP"
    PASS_COUNT=$((PASS_COUNT + 1))
fi
# Ordering: the preflight must run BEFORE the retry loop (line numbers).
MK_LINE=$(grep -n "syncInfoCache" "${BLOCK_FILE}" | head -1 | cut -d: -f1)
LOOP_LINE=$(grep -n "Running periodic post-sync E2EE decrypt" "${BLOCK_FILE}" | head -1 | cut -d: -f1)
if [ -n "${MK_LINE}" ] && [ -n "${LOOP_LINE}" ] && [ "${MK_LINE}" -lt "${LOOP_LINE}" ]; then
    echo "PASS: Preflight precedes the retry loop"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Preflight does not precede the retry loop (mk=${MK_LINE}, loop=${LOOP_LINE})"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
# Pollution guard: decrypt output must go to the dedicated e2ee-decrypt-*.log
# files, never to sync-stdout/stderr.log (the next cycle's check_sync_errors
# greps those in full — stale decrypt stderr would false-FAIL a clean sync).
if grep -q "e2ee-decrypt-stdout.log" "${BLOCK_FILE}" && grep -q "e2ee-decrypt-stderr.log" "${BLOCK_FILE}" \
    && ! grep -q "sync-stdout.log" "${BLOCK_FILE}" && ! grep -q "sync-stderr.log" "${BLOCK_FILE}"; then
    echo "PASS: Decrypt output goes only to e2ee-decrypt-*.log (no sync-log pollution)"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Decrypt output redirection is wrong (sync-log pollution risk)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# --- Groups 1-7: source the block (defines the function), then call it ---
# shellcheck disable=SC1090
source "${BLOCK_FILE}"

echo ""
echo "=== Group 1: no master password → complete no-op ==="
unset JOPLIN_MASTER_PASSWORD
echo "0" > "${MK_COUNT_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
FLOCK_CALLS=0
NODE_CALLS=0
: > "${CAPTURE}"
RC=0
run_periodic_e2ee_decrypt || RC=$?
assert_eq "no password → rc 0 (skip, never fail)" "0" "${RC}"
assert_eq "no password → no probe run (node calls)" "0" "${NODE_CALLS}"
assert_eq "no password → no decrypt attempt (flock calls)" "0" "${FLOCK_CALLS}"
assert_marker_absent "no password → no halt marker"

echo ""
echo "=== Group 2: 0 master keys → doomed decrypt skipped, loop continues ==="
JOPLIN_MASTER_PASSWORD="test-password"
echo "0" > "${MK_COUNT_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
FLOCK_CALLS=0
NODE_CALLS=0
: > "${CAPTURE}"
RC=0
run_periodic_e2ee_decrypt || RC=$?
assert_eq "0 keys → rc 0 (skip, no halt)" "0" "${RC}"
assert_eq "0 keys → retry loop NOT entered (flock calls)" "0" "${FLOCK_CALLS}"
assert_capture_contains "0 keys → [SYNC_SKIP] logged" "SYNC_SKIP"
assert_capture_contains "0 keys → skip names the cause" "no master key is present"
assert_marker_absent "0 keys → no halt marker (never halt from the loop)"

echo ""
echo "=== Group 3: healthy path → decrypt once, verification passes ==="
echo "3" > "${MK_COUNT_FILE}"
echo "0" > "${REMAINING_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
FLOCK_CALLS=0
NODE_CALLS=0
: > "${CAPTURE}"
RC=0
run_periodic_e2ee_decrypt || RC=$?
assert_eq "healthy → rc 0" "0" "${RC}"
assert_eq "healthy → retry loop entered exactly once" "1" "${FLOCK_CALLS}"
assert_capture_contains "healthy → preflight INFO logged" "master-key preflight passed"
assert_capture_contains "healthy → [SYNC_PASS] completion logged" "SYNC_PASS"
assert_capture_contains "healthy → completion reports 0 remaining" "0 encrypted items remaining"
assert_marker_absent "healthy → no halt marker"

echo ""
echo "=== Group 4: preflight probe garbage → falls through to the retry ==="
echo "n/a" > "${MK_COUNT_FILE}"
echo "0" > "${REMAINING_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
FLOCK_CALLS=0
: > "${CAPTURE}"
RC=0
run_periodic_e2ee_decrypt || RC=$?
assert_eq "probe garbage → rc 0 (decrypt succeeded)" "0" "${RC}"
assert_eq "probe garbage → retry loop entered (fall-through)" "1" "${FLOCK_CALLS}"
assert_capture_contains "probe garbage → WARN logged (no silent fallback)" "cannot confirm master-key presence"
assert_marker_absent "probe garbage → no halt marker"

echo ""
echo "=== Group 5: decrypt fails 4× → [SYNC_FAIL], NO halt, loop continues ==="
echo "1" > "${MK_COUNT_FILE}"
echo "0" > "${REMAINING_FILE}"
echo "fail" > "${FLOCK_MODE_FILE}"
FLOCK_CALLS=0
: > "${CAPTURE}"
RC=0
run_periodic_e2ee_decrypt || RC=$?
assert_eq "decrypt fails → rc nonzero" "1" "${RC}"
assert_eq "decrypt fails → full retry budget spent (4 attempts)" "4" "${FLOCK_CALLS}"
assert_capture_contains "decrypt fails → [SYNC_FAIL] logged" "SYNC_FAIL"
assert_capture_contains "decrypt fails → message names the retry contract" "will retry on the next periodic sync"
assert_marker_absent "decrypt fails → NO halt marker (never halt from the loop)"

echo ""
echo "=== Group 6: decrypt exits 0 but items remain → verification [SYNC_FAIL] ==="
echo "1" > "${MK_COUNT_FILE}"
echo "7" > "${REMAINING_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
FLOCK_CALLS=0
: > "${CAPTURE}"
RC=0
run_periodic_e2ee_decrypt || RC=$?
assert_eq "7 remaining → rc nonzero" "1" "${RC}"
assert_capture_contains "7 remaining → verification [SYNC_FAIL] logged" "still encrypted after decrypt"
assert_marker_absent "7 remaining → NO halt marker"

echo ""
echo "=== Group 7: verification probe garbage → fail-closed [SYNC_FAIL] ==="
echo "1" > "${MK_COUNT_FILE}"
rm -f "${REMAINING_FILE}"
echo "success" > "${FLOCK_MODE_FILE}"
FLOCK_CALLS=0
: > "${CAPTURE}"
RC=0
run_periodic_e2ee_decrypt || RC=$?
assert_eq "verify probe fails → rc nonzero (fail-closed)" "1" "${RC}"
assert_capture_contains "verify probe fails → [SYNC_FAIL] logged" "probe failed or returned a non-integer"
assert_marker_absent "verify probe fails → NO halt marker"

# --- Structural pin: the loop body must actually call the helper ---
echo ""
echo "=== Group 8: loop-body call-site pin ==="
# The call must sit INSIDE the setsid loop string and AFTER the periodic
# [SYNC_PASS] line (line-number ordering, drift-proof like Group 0 of
# tests/test-e2ee-master-key-preflight.sh).
PASS_LINE=$(grep -n 'log_sync "PASS" "Periodic sync completed successfully"' "${ENTRYPOINT}" | head -1 | cut -d: -f1)
CALL_LINE=$(grep -n 'run_periodic_e2ee_decrypt || true' "${ENTRYPOINT}" | head -1 | cut -d: -f1)
LOOP_START=$(grep -n 'setsid bash -c' "${ENTRYPOINT}" | head -1 | cut -d: -f1)
if [ -n "${PASS_LINE}" ] && [ -n "${CALL_LINE}" ] && [ "${PASS_LINE}" -lt "${CALL_LINE}" ]; then
    echo "PASS: Loop body calls the decrypt step after the periodic [SYNC_PASS] line"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Loop-body call missing or misordered (pass=${PASS_LINE}, call=${CALL_LINE})"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if [ -n "${LOOP_START}" ] && [ -n "${CALL_LINE}" ] && [ "${LOOP_START}" -lt "${CALL_LINE}" ]; then
    echo "PASS: Call site is inside the periodic loop block"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Call site is not inside the periodic loop block (loop=${LOOP_START}, call=${CALL_LINE})"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if grep -q "export -f.*run_periodic_e2ee_decrypt" "${ENTRYPOINT}"; then
    echo "PASS: run_periodic_e2ee_decrypt is exported to the loop child"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: run_periodic_e2ee_decrypt is not exported — the loop child cannot see it"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if grep -q "export SYNC_INTERVAL_SECONDS.*JOPLIN_MASTER_PASSWORD" "${ENTRYPOINT}"; then
    echo "PASS: JOPLIN_MASTER_PASSWORD is exported to the loop child"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: JOPLIN_MASTER_PASSWORD is not exported — the loop-side gate would never arm"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi
# Only ONE decrypt call site may exist in the loop string (the helper call);
# the flock-wrapped decrypt invocation must live in exactly two places:
# the boot block and the helper.
DECRYPT_CALLS=$(grep -c "flock -w 120 \"\${SYNC_LOCK_FILE}\" -c 'joplin e2ee decrypt --force'" "${ENTRYPOINT}" || true)
assert_eq "decrypt invocation appears exactly twice (boot + periodic helper)" "2" "${DECRYPT_CALLS}"

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
