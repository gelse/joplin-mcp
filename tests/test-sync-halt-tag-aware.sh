#!/usr/bin/env bash
# Unit tests for the D4 tag-aware sync-halt refusal messages
# (entrypoint-combined.sh, backlog decision D4).
#
# The halt marker is a latch written by several halt sites, each emitting its
# own bracketed tag into the marker: [CIRCUIT_BREAKER] / [SYNC_ABORT] →
# issue #27 (destructive deletion), [E2EE_DECRYPT_FAIL] /
# [E2EE_DECRYPT_INCOMPLETE] / [E2EE_NO_MASTER_KEY] → issue #29 (E2EE).
# The READ side (refusal messages) must extract that tag and route the
# operator to the correct issue instead of the old hardcoded "issue #27".
#
# Fail-safe contract under test: every unknown state — empty marker, no
# bracketed tag, unrecognized/future tag, unreadable file — falls back to the
# byte-identical pre-D4 generic wording ("investigating issue #27"), never to
# a wrong issue, and never crashes (set -e survives).
#
# The read-side helper block is extracted VERBATIM from entrypoint-combined.sh
# and sourced with a stubbed `log` — the same real-block technique as
# tests/test-e2ee-master-key-preflight.sh (catches drift between the test and
# the shipped functions). Structural assertions additionally pin that both
# halt gates call the helper and that control flow (gate count,
# START_PERIODIC_LOOP fail-safe default, sleep+continue) is unchanged.
set -euo pipefail

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRYPOINT="${SCRIPT_DIR}/../entrypoint-combined.sh"

# --- Test harness ---
TEST_DIR="$(mktemp -d)"
SYNC_HALT_MARKER="${TEST_DIR}/.sync-halt"   # consumed by the sourced D4 block
CAPTURE="${TEST_DIR}/capture.log"
BLOCK_FILE="${TEST_DIR}/d4-block.sh"
mkdir -p "${TEST_DIR}"

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

assert_file_contains() {
    local name="$1" file="$2" pattern="$3"
    if grep -q "${pattern}" "${file}"; then
        echo "PASS: ${name}"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        echo "FAIL: ${name} (${file} lacks '${pattern}')"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

# --- Stub log (capture message lines for assertions) ---
log() { printf '%s\n' "$2" >> "${CAPTURE}"; }

# --- Reset per-scenario state ---
reset_scenario() {
    rm -f "${SYNC_HALT_MARKER}"
    : > "${CAPTURE}"
}

# --- Byte-identical pre-D4 generic refusal pair (the fail-safe fallback) ---
GENERIC_PAIR="Sync halt marker exists — refusing to sync (see ${SYNC_HALT_MARKER})
Remove ${SYNC_HALT_MARKER} to re-enable sync after investigating issue #27"

# =========================================================================
# Group 0: extraction sanity + structural control-flow pins
# =========================================================================
echo "=== Group 0: extraction sanity + structural control-flow pins ==="

# --- Extract the D4 read-side helper block verbatim from the entrypoint ---
awk 'index($0, "# ----- D4 block begin") { inblock = 1 }
     inblock { print }
     inblock && index($0, "# ----- D4 block end -----") { exit }' "${ENTRYPOINT}" > "${BLOCK_FILE}"

for fn in halt_marker_tag halt_marker_issue log_halt_marker_refusal halt_marker_issue_note; do
    assert_file_contains "Extracted block defines ${fn}()" "${BLOCK_FILE}" "^${fn}()"
done

# All five known writer tags are covered by the issue mapping in the block.
for tag in CIRCUIT_BREAKER SYNC_ABORT E2EE_DECRYPT_FAIL E2EE_DECRYPT_INCOMPLETE E2EE_NO_MASTER_KEY; do
    assert_file_contains "Issue mapping covers [${tag}]" "${BLOCK_FILE}" "${tag}"
done

# Control flow preserved: exactly two marker-existence gates (initial + loop;
# line-anchored so the cleanup `elif` and the final-sync condition don't match).
GATE_COUNT=$(grep -cE '^[[:space:]]*if \[ -f "\$\{SYNC_HALT_MARKER\}" \]; then$' "${ENTRYPOINT}")
assert_eq "Exactly 2 halt gates remain (initial + periodic loop)" "2" "${GATE_COUNT}"

# ... plus the final-sync condition and the cleanup elif (unchanged sites).
MARKER_CHECKS=$(grep -c '\[ -f "${SYNC_HALT_MARKER}" \]' "${ENTRYPOINT}")
assert_eq "All 4 marker checks remain (2 gates + final-sync condition + cleanup elif)" "4" "${MARKER_CHECKS}"

# Both gates delegate to the shared refusal helper (bare call sites only).
CALL_SITES=$(grep -cE '^[[:space:]]*log_halt_marker_refusal[[:space:]]*$' "${ENTRYPOINT}")
assert_eq "Both gates call log_halt_marker_refusal" "2" "${CALL_SITES}"

# The old hardcoded refusal pair survives ONLY inside the helper branches.
OLD_PAIRS=$(grep -c 'Sync halt marker exists' "${ENTRYPOINT}")
assert_eq "Old refusal text appears only in the helper (2 branches)" "2" "${OLD_PAIRS}"
GENERIC_27=$(grep -c 'investigating issue #27' "${ENTRYPOINT}")
assert_eq "Hardcoded '#27' refusal remains only as the helper fallback" "1" "${GENERIC_27}"

# Fail-safe default is intact: halt-gated startup must not abort under set -u.
assert_file_contains "START_PERIODIC_LOOP fail-safe default intact" "${ENTRYPOINT}" ': "${START_PERIODIC_LOOP:=0}"'

# Loop-gate mechanism preserved: refusal call is followed by `continue`
# (the refusal helper must never turn the alive-loop into an exit; M12
# removed the gate's second sleep, so `continue` returns to the single
# top-of-loop sleep).
grep -A5 "log_halt_marker_refusal" "${ENTRYPOINT}" | grep -q "continue"
if [ $? -eq 0 ]; then
    echo "PASS: Loop gate still continues after the refusal (alive-loop intact)"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo "FAIL: Loop gate lost its continue after the refusal"
    FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# The helpers are exported into the setsid bash -c subshell.
assert_file_contains "Refusal helper exported for the setsid loop" "${ENTRYPOINT}" 'export -f.*log_halt_marker_refusal'

# =========================================================================
# Group 1: tag extraction from writer-format first lines (halt_marker_tag)
# =========================================================================
echo ""
echo "=== Group 1: halt_marker_tag extraction ==="

# shellcheck disable=SC1090
source "${BLOCK_FILE}"

extract_tag_from() {
    local content="$1"
    printf '%s' "${content}" > "${SYNC_HALT_MARKER}"
    halt_marker_tag
}

assert_eq "CIRCUIT_BREAKER writer line → CIRCUIT_BREAKER" "CIRCUIT_BREAKER" \
    "$(extract_tag_from "2026-10-04T00:00:00Z [CIRCUIT_BREAKER] 3 items deleted (threshold: 100). Pre-sync: 10, post-sync: 7. Sync halted. See issue #27.")"
assert_eq "SYNC_ABORT writer line → SYNC_ABORT" "SYNC_ABORT" \
    "$(extract_tag_from "2026-10-04T00:00:00Z [SYNC_ABORT] Destructive sync signature detected — sync halted. See issue #27.")"
assert_eq "E2EE_DECRYPT_FAIL writer line → E2EE_DECRYPT_FAIL" "E2EE_DECRYPT_FAIL" \
    "$(extract_tag_from "2026-10-04T00:00:00Z [E2EE_DECRYPT_FAIL] decrypt did not complete after 4 attempts. See issue #29.")"
assert_eq "E2EE_DECRYPT_INCOMPLETE writer line → E2EE_DECRYPT_INCOMPLETE" "E2EE_DECRYPT_INCOMPLETE" \
    "$(extract_tag_from "2026-10-04T00:00:00Z [E2EE_DECRYPT_INCOMPLETE] 7 item(s) still encrypted after decrypt. See issue #29.")"
assert_eq "E2EE_NO_MASTER_KEY writer line → E2EE_NO_MASTER_KEY" "E2EE_NO_MASTER_KEY" \
    "$(extract_tag_from "2026-10-04T00:00:00Z [E2EE_NO_MASTER_KEY] master password configured but no master key is present (E2EE disabled on the server). See issue #29.")"

# Edge cases (must yield "" — the callers fall back to the generic wording).
printf '' > "${SYNC_HALT_MARKER}"
assert_eq "Empty marker → no tag" "" "$(halt_marker_tag)"
assert_eq "No bracketed tag → no tag" "" "$(extract_tag_from "sync halted, good luck")"
assert_eq "Lowercase tag → no tag" "" "$(extract_tag_from "2026-10-04T00:00:00Z [circuit_breaker] lowercase")"
assert_eq "Tag only on second line → no tag (first-line contract)" "" \
    "$(extract_tag_from "$(printf 'first line without tag\n[SYNC_ABORT] second line')")"
assert_eq "Malformed first line (unclosed bracket) → no tag" "" \
    "$(extract_tag_from "2026-10-04T00:00:00Z [E2EE_DECRYPT_FAIL no closing bracket")"
assert_eq "Malformed first line (empty brackets) → no tag" "" \
    "$(extract_tag_from "2026-10-04T00:00:00Z [] nothing")"

# An unknown-but-well-formed tag IS extracted (content-based); the issue
# mapping below decides the fail-safe fallback.
assert_eq "Unknown future tag → extracted verbatim" "FUTURE_PROBLEM" \
    "$(extract_tag_from "2026-10-04T00:00:00Z [FUTURE_PROBLEM] something new. See issue #42.")"

# =========================================================================
# Group 2: issue mapping (halt_marker_issue)
# =========================================================================
echo ""
echo "=== Group 2: halt_marker_issue mapping ==="

assert_eq "CIRCUIT_BREAKER → issue 27" "27" "$(halt_marker_issue CIRCUIT_BREAKER)"
assert_eq "SYNC_ABORT → issue 27" "27" "$(halt_marker_issue SYNC_ABORT)"
assert_eq "E2EE_DECRYPT_FAIL → issue 29" "29" "$(halt_marker_issue E2EE_DECRYPT_FAIL)"
assert_eq "E2EE_DECRYPT_INCOMPLETE → issue 29" "29" "$(halt_marker_issue E2EE_DECRYPT_INCOMPLETE)"
assert_eq "E2EE_NO_MASTER_KEY → issue 29" "29" "$(halt_marker_issue E2EE_NO_MASTER_KEY)"
assert_eq "Empty tag → no issue (generic fallback)" "" "$(halt_marker_issue "")"
assert_eq "Unknown/future tag → no issue (never a wrong issue)" "" "$(halt_marker_issue FUTURE_PROBLEM)"

# =========================================================================
# Group 3: tag-aware refusal pair (log_halt_marker_refusal)
# =========================================================================
echo ""
echo "=== Group 3: log_halt_marker_refusal routing ==="

# --- #27 tag: destructive-deletion circuit breaker ---
reset_scenario
printf '%s\n' "2026-10-04T00:00:00Z [CIRCUIT_BREAKER] 3 items deleted (threshold: 100). Pre-sync: 10, post-sync: 7. Sync halted. See issue #27." > "${SYNC_HALT_MARKER}"
log_halt_marker_refusal
assert_capture_contains "CIRCUIT_BREAKER refusal names the tag" "tag \[CIRCUIT_BREAKER\]"
assert_capture_contains "CIRCUIT_BREAKER refusal routes to issue #27" "investigating issue #27"
assert_capture_contains "CIRCUIT_BREAKER refusal keeps the Remove instruction" "Remove ${SYNC_HALT_MARKER} to re-enable sync"
assert_capture_not_contains "CIRCUIT_BREAKER refusal never mentions issue #29" "issue #29"

# --- #29 tag: E2EE decrypt failure must NOT be routed to #27 ---
reset_scenario
printf '%s\n' "2026-10-04T00:00:00Z [E2EE_DECRYPT_FAIL] decrypt did not complete after 4 attempts. See issue #29." > "${SYNC_HALT_MARKER}"
log_halt_marker_refusal
assert_capture_contains "E2EE_DECRYPT_FAIL refusal names the tag" "tag \[E2EE_DECRYPT_FAIL\]"
assert_capture_contains "E2EE_DECRYPT_FAIL refusal routes to issue #29" "investigating issue #29"
assert_capture_contains "E2EE_DECRYPT_FAIL refusal keeps the Remove instruction" "Remove ${SYNC_HALT_MARKER} to re-enable sync"
assert_capture_not_contains "E2EE_DECRYPT_FAIL refusal never mentions issue #27" "investigating issue #27"

# --- Edge cases: byte-identical pre-D4 generic pair, no crash under set -e ---
reset_scenario
printf '' > "${SYNC_HALT_MARKER}"
log_halt_marker_refusal
assert_eq "Empty marker → byte-identical generic pair" "${GENERIC_PAIR}" "$(cat "${CAPTURE}")"

reset_scenario
printf '%s\n' "no bracketed tag in here" > "${SYNC_HALT_MARKER}"
log_halt_marker_refusal
assert_eq "No-tag marker → byte-identical generic pair" "${GENERIC_PAIR}" "$(cat "${CAPTURE}")"

reset_scenario
printf '%s\n' "2026-10-04T00:00:00Z [FUTURE_PROBLEM] something new. See issue #42." > "${SYNC_HALT_MARKER}"
log_halt_marker_refusal
assert_eq "Unknown future tag → byte-identical generic pair" "${GENERIC_PAIR}" "$(cat "${CAPTURE}")"

reset_scenario
printf '%s\n' "2026-10-04T00:00:00Z [circuit_breaker] lowercase tag" > "${SYNC_HALT_MARKER}"
log_halt_marker_refusal
assert_eq "Lowercase tag → byte-identical generic pair" "${GENERIC_PAIR}" "$(cat "${CAPTURE}")"

reset_scenario
printf '%s\n' "2026-10-04T00:00:00Z [E2EE_DECRYPT_FAIL no closing bracket" > "${SYNC_HALT_MARKER}"
log_halt_marker_refusal
assert_eq "Malformed first line (unclosed bracket) → byte-identical generic pair" "${GENERIC_PAIR}" "$(cat "${CAPTURE}")"

reset_scenario
printf '%s\n' "2026-10-04T00:00:00Z [] nothing" > "${SYNC_HALT_MARKER}"
log_halt_marker_refusal
assert_eq "Malformed first line (empty brackets) → byte-identical generic pair" "${GENERIC_PAIR}" "$(cat "${CAPTURE}")"

# Unreadable marker (permissions). NOTE: skipped under root — root reads
# chmod 000 files regardless, and then the tag-aware branch is CORRECT.
reset_scenario
printf '%s\n' "2026-10-04T00:00:00Z [E2EE_NO_MASTER_KEY] no master key. See issue #29." > "${SYNC_HALT_MARKER}"
chmod 000 "${SYNC_HALT_MARKER}"
if [ ! -r "${SYNC_HALT_MARKER}" ]; then
    log_halt_marker_refusal
    assert_eq "Unreadable marker → byte-identical generic pair" "${GENERIC_PAIR}" "$(cat "${CAPTURE}")"
else
    echo "SKIP: unreadable-marker case (running as root; chmod 000 is still readable)"
    chmod 600 "${SYNC_HALT_MARKER}"
fi

# =========================================================================
# Group 4: single-line note suffix (halt_marker_issue_note)
# =========================================================================
echo ""
echo "=== Group 4: halt_marker_issue_note suffix ==="

reset_scenario
printf '%s\n' "2026-10-04T00:00:00Z [SYNC_ABORT] Destructive sync signature detected — sync halted. See issue #27." > "${SYNC_HALT_MARKER}"
assert_eq "SYNC_ABORT note → tag + issue 27" ", tag [SYNC_ABORT], issue #27" "$(halt_marker_issue_note)"

reset_scenario
printf '%s\n' "2026-10-04T00:00:00Z [E2EE_NO_MASTER_KEY] no master key present. See issue #29." > "${SYNC_HALT_MARKER}"
assert_eq "E2EE_NO_MASTER_KEY note → tag + issue 29" ", tag [E2EE_NO_MASTER_KEY], issue #29" "$(halt_marker_issue_note)"

reset_scenario
printf '' > "${SYNC_HALT_MARKER}"
assert_eq "Empty marker → empty note (wording unchanged)" "" "$(halt_marker_issue_note)"

reset_scenario
printf '%s\n' "2026-10-04T00:00:00Z [FUTURE_PROBLEM] something new. See issue #42." > "${SYNC_HALT_MARKER}"
assert_eq "Unknown tag → empty note (never a wrong issue)" "" "$(halt_marker_issue_note)"

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
