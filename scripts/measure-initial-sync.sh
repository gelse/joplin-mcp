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
TMPFILE="$(mktemp)"

# ---------------------------------------------------------------------------
# Cleanup trap
# ---------------------------------------------------------------------------
cleanup() {
    echo "Cleaning up container and volume..."
    docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
    docker volume rm "${VOLUME_NAME}" 2>/dev/null || true
    rm -f "${TMPFILE}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Count synced items (notes + folders) via joplin CLI inside the container
# ---------------------------------------------------------------------------
get_item_count() {
    local count=0
    # Count folders
    if docker exec "${CONTAINER_NAME}" joplin ls /folders -l 99999 > "${TMPFILE}" 2>/dev/null; then
        local fc
        fc="$(wc -l < "${TMPFILE}")"
        count=$((count + fc))
    fi
    # Count notes
    if docker exec "${CONTAINER_NAME}" joplin ls /notes -l 99999 > "${TMPFILE}" 2>/dev/null; then
        local nc
        nc="$(wc -l < "${TMPFILE}")"
        count=$((count + nc))
    fi
    echo "${count}"
}

# ---------------------------------------------------------------------------
# Start container with throwaway volume
# ---------------------------------------------------------------------------
echo "=== Initial Sync Measurement ==="
echo "Image:       ${IMAGE_NAME}"
echo "Volume:      ${VOLUME_NAME}"
echo "Max minutes: ${MAX_MINUTES}"
echo "Interval:    ${INTERVAL_SECONDS}s"
echo ""

docker run -d \
    --name "${CONTAINER_NAME}" \
    -v "${VOLUME_NAME}:/home/joplin/.config/joplin" \
    -e "JOPLIN_SERVER_URL=${JOPLIN_SERVER_URL}" \
    -e "JOPLIN_USERNAME=${JOPLIN_USERNAME}" \
    -e "JOPLIN_PASSWORD=${JOPLIN_PASSWORD}" \
    -e "LOG_LEVEL=${LOG_LEVEL:-warn}" \
    -e "SYNC_INTERVAL_SECONDS=99999" \
    "${IMAGE_NAME}"

echo "Container started. Waiting for initial sync to complete..."
echo "(This may take a while for large libraries.)"
echo ""

# ---------------------------------------------------------------------------
# Wait for initial sync to finish
# ---------------------------------------------------------------------------
WAIT_ELAPSED=0
SYNC_TIMEOUT_SECONDS=$((MAX_MINUTES * 60))
sync_done=0
while [ "${WAIT_ELAPSED}" -lt "${SYNC_TIMEOUT_SECONDS}" ]; do
    if docker logs "${CONTAINER_NAME}" 2>&1 | grep -q "Initial sync completed\|Initial sync failed"; then
        sync_done=1
        break
    fi
    sleep 10
    WAIT_ELAPSED=$((WAIT_ELAPSED + 10))
    if [ $((WAIT_ELAPSED % 30)) -eq 0 ]; then
        echo -n "."
    fi
done
echo ""

if [ "${sync_done}" -eq 0 ]; then
    echo "ERROR: Initial sync did not complete within ${MAX_MINUTES} minutes." >&2
    exit 1
fi

echo "Initial sync finished. Starting measurement polling..."
echo ""

# ---------------------------------------------------------------------------
# Poll item count at intervals
# ---------------------------------------------------------------------------
START_TIME="$(date +%s)"
LAST_COUNT=0
LAST_TIME="${START_TIME}"
POLL=0
MAX_SECONDS=$((MAX_MINUTES * 60))

echo "Poll | Elapsed  | Items | Delta | items/min | Avg items/min"
echo "-----|----------|-------|-------|-----------|--------------"

while true; do
    NOW="$(date +%s)"
    ELAPSED=$((NOW - START_TIME))

    if [ "${ELAPSED}" -ge "${MAX_SECONDS}" ]; then
        echo ""
        echo "Maximum measurement time (${MAX_MINUTES} min) reached."
        break
    fi

    CURRENT_COUNT="$(get_item_count)"
    DELTA=$((CURRENT_COUNT - LAST_COUNT))

    if [ "${LAST_COUNT}" -gt 0 ]; then
        INTERVAL_ELAPSED=$((NOW - LAST_TIME))
        if [ "${INTERVAL_ELAPSED}" -gt 0 ]; then
            RATE="$(echo "scale=1; ${DELTA} * 60 / ${INTERVAL_ELAPSED}" | bc)"
        else
            RATE="0.0"
        fi
        AVG_RATE="$(echo "scale=1; ${CURRENT_COUNT} * 60 / ${ELAPSED}" | bc)"
    else
        RATE="-"
        AVG_RATE="-"
    fi

    POLL=$((POLL + 1))
    printf "%4d | %2dm%02ds   | %5d | %5d | %9s | %s\n" \
        "${POLL}" \
        "$((ELAPSED / 60))" "$((ELAPSED % 60))" \
        "${CURRENT_COUNT}" \
        "${DELTA}" \
        "${RATE}" \
        "${AVG_RATE}"

    LAST_COUNT="${CURRENT_COUNT}"
    LAST_TIME="${NOW}"

    if [ "${CURRENT_COUNT}" -gt 0 ] && [ "${DELTA}" -eq 0 ] && [ "${POLL}" -gt 2 ]; then
        echo ""
        echo "Item count stabilised (no change for 2 consecutive polls). Stopping."
        break
    fi

    sleep "${INTERVAL_SECONDS}"
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
END_TIME="$(date +%s)"
TOTAL_ELAPSED=$((END_TIME - START_TIME))
FINAL_COUNT="$(get_item_count)"
if [ "${TOTAL_ELAPSED}" -gt 0 ]; then
    OVERALL_RATE="$(echo "scale=1; ${FINAL_COUNT} * 60 / ${TOTAL_ELAPSED}" | bc)"
else
    OVERALL_RATE="N/A"
fi

echo ""
echo "=== Summary ==="
echo "Total elapsed: $((TOTAL_ELAPSED / 60))m$((TOTAL_ELAPSED % 60))s"
echo "Total items:   ${FINAL_COUNT}"
echo "Overall rate:  ${OVERALL_RATE} items/min"
echo ""
echo "Container and volume will be cleaned up on exit."
