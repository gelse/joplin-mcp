#!/usr/bin/env bash
# =============================================================================
# measure-initial-sync.sh — Time-bounded measurement of items/min during an
# initial sync using a throwaway container with a fresh volume.
#
# Requirements:
#   - Docker running
#   - Combined image built (docker compose build)
#   - JOPLIN_SERVER_URL, JOPLIN_USERNAME, JOPLIN_PASSWORD set in environment
#
# Optional env vars:
#   MAX_MINUTES       — maximum measurement duration (default: 10)
#   INTERVAL_SECONDS  — polling interval (default: 60)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Env-var checks
# ---------------------------------------------------------------------------
for var in JOPLIN_SERVER_URL JOPLIN_USERNAME JOPLIN_PASSWORD; do
    if [ -z "${!var:-}" ]; then
        echo "ERROR: ${var} is not set." >&2
        exit 1
    fi
done

MAX_MINUTES="${MAX_MINUTES:-10}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-60}"
IMAGE_NAME="joplin-api-combined"
VOLUME_NAME="joplin-measure-$(date +%s)"
CONTAINER_NAME="joplin-measure-$$"
POLL_TMPFILE="$(mktemp)"
ENVFILE="$(mktemp)"
chmod 600 "${ENVFILE}"

# ---------------------------------------------------------------------------
# Cleanup trap
# ---------------------------------------------------------------------------
cleanup() {
    echo "Cleaning up container and volume..."
    docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
    docker volume rm "${VOLUME_NAME}" 2>/dev/null || true
    rm -f "${POLL_TMPFILE}" "${ENVFILE}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Count synced items (notes + folders) via joplin CLI inside the container
# ---------------------------------------------------------------------------
get_item_count() {
    local count=0
    # Count folders
    if docker exec "${CONTAINER_NAME}" joplin ls /folders -l 99999 > "${POLL_TMPFILE}" 2>/dev/null; then
        local fc
        fc="$(wc -l < "${POLL_TMPFILE}")"
        count=$((count + fc))
    fi
    # Count notes
    if docker exec "${CONTAINER_NAME}" joplin ls /notes -l 99999 > "${POLL_TMPFILE}" 2>/dev/null; then
        local nc
        nc="$(wc -l < "${POLL_TMPFILE}")"
        count=$((count + nc))
    fi
    echo "${count}"
}

# ---------------------------------------------------------------------------
# Start container with throwaway volume
# Credentials are passed via an env-file (not -e KEY=VALUE) to avoid
# exposing the plaintext password in the process list.
# ---------------------------------------------------------------------------
printf 'JOPLIN_SERVER_URL=%s\n' "${JOPLIN_SERVER_URL}" >> "${ENVFILE}"
printf 'JOPLIN_USERNAME=%s\n'   "${JOPLIN_USERNAME}"   >> "${ENVFILE}"
printf 'JOPLIN_PASSWORD=%s\n'   "${JOPLIN_PASSWORD}"   >> "${ENVFILE}"
printf 'LOG_LEVEL=%s\n'         "${LOG_LEVEL:-warn}"   >> "${ENVFILE}"
printf 'SYNC_INTERVAL_SECONDS=%s\n' "99999"             >> "${ENVFILE}"

echo "=== Initial Sync Measurement ==="
echo "Image:       ${IMAGE_NAME}"
echo "Volume:      ${VOLUME_NAME}"
echo "Max minutes: ${MAX_MINUTES}"
echo "Interval:    ${INTERVAL_SECONDS}s"
echo ""

docker run -d \
    --name "${CONTAINER_NAME}" \
    -v "${VOLUME_NAME}:/home/joplin/.config/joplin" \
    --env-file "${ENVFILE}" \
    "${IMAGE_NAME}"

# ---------------------------------------------------------------------------
# Poll item counts DURING the initial sync; the completion log line
# terminates the loop (it is not a precondition).
# ---------------------------------------------------------------------------
LAUNCH_TIME="$(date +%s)"
SYNC_TIMEOUT_SECONDS=$((MAX_MINUTES * 60))
LAST_COUNT=0
LAST_TIME="${LAUNCH_TIME}"
POLL=0
SYNC_OUTCOME="timed-out"  # will be overwritten on completion

echo "Container started. Polling item count during initial sync..."
echo "(This may take a while for large libraries.)"
echo ""
echo "Poll | Elapsed  | Items | Delta | items/min | Avg items/min"
echo "-----|----------|-------|-------|-----------|--------------"

while true; do
    sleep "${INTERVAL_SECONDS}"

    NOW="$(date +%s)"
    ELAPSED=$((NOW - LAUNCH_TIME))
    POLL=$((POLL + 1))

    # --- Check for sync completion / failure / error in container logs ---
    if docker logs "${CONTAINER_NAME}" 2>&1 | grep -q "Initial sync completed"; then
        SYNC_OUTCOME="completed"
    elif docker logs "${CONTAINER_NAME}" 2>&1 | grep -q "Initial sync failed"; then
        SYNC_OUTCOME="failed"
    elif docker logs "${CONTAINER_NAME}" 2>&1 | grep -q "Initial sync reported errors"; then
        SYNC_OUTCOME="errored"
    fi

    # --- Poll item count ---
    CURRENT_COUNT="$(get_item_count)"
    DELTA=$((CURRENT_COUNT - LAST_COUNT))

    if [ "${LAST_COUNT}" -gt 0 ]; then
        INTERVAL_ELAPSED=$((NOW - LAST_TIME))
        if [ "${INTERVAL_ELAPSED}" -gt 0 ]; then
            RATE="$(awk -v d="${DELTA}" -v i="${INTERVAL_ELAPSED}" 'BEGIN { printf "%.1f", d*60/i }')"
        else
            RATE="0.0"
        fi
        AVG_RATE="$(awk -v c="${CURRENT_COUNT}" -v e="${ELAPSED}" 'BEGIN { printf "%.1f", c*60/e }')"
    else
        RATE="-"
        AVG_RATE="-"
    fi

    printf "%4d | %2dm%02ds   | %5d | %5d | %9s | %s\n" \
        "${POLL}" \
        "$((ELAPSED / 60))" "$((ELAPSED % 60))" \
        "${CURRENT_COUNT}" \
        "${DELTA}" \
        "${RATE}" \
        "${AVG_RATE}"

    LAST_COUNT="${CURRENT_COUNT}"
    LAST_TIME="${NOW}"

    # --- Termination: sync finished or timed out ---
    if [ "${SYNC_OUTCOME}" != "timed-out" ]; then
        break
    fi

    if [ "${ELAPSED}" -ge "${SYNC_TIMEOUT_SECONDS}" ]; then
        break
    fi
done

echo ""

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
END_TIME="$(date +%s)"
TOTAL_ELAPSED=$((END_TIME - LAUNCH_TIME))
FINAL_COUNT="$(get_item_count)"

if [ "${TOTAL_ELAPSED}" -gt 0 ]; then
    OVERALL_RATE="$(awk -v c="${FINAL_COUNT}" -v e="${TOTAL_ELAPSED}" 'BEGIN { printf "%.1f", c*60/e }')"
else
    OVERALL_RATE="N/A"
fi

echo "=== Summary ==="

case "${SYNC_OUTCOME}" in
    completed)
        echo "Outcome:     Initial sync completed successfully."
        ;;
    failed)
        echo "Outcome:     Initial sync FAILED (non-zero exit code)."
        ;;
    errored)
        echo "Outcome:     Initial sync reported ERRORS despite exit code 0."
        ;;
    timed-out)
        echo "Outcome:     Timed out after ${MAX_MINUTES} minutes — sync did NOT complete."
        ;;
esac

echo "Total elapsed: $((TOTAL_ELAPSED / 60))m$((TOTAL_ELAPSED % 60))s"
echo "Total items:   ${FINAL_COUNT}"
echo "Overall rate:  ${OVERALL_RATE} items/min"
echo ""
echo "Container and volume will be cleaned up on exit."

if [ "${SYNC_OUTCOME}" = "timed-out" ]; then
    exit 0
fi
