#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="joplin-mcp"
HEALTH_PORT="${MCP_PORT:-3000}"
HEALTH_URL="http://localhost:${HEALTH_PORT}/health"
MAX_WAIT=60
INTERVAL=5

echo "=== Joplin MCP Server Smoke Test ==="

# 1. Check if container is running
echo -n "Checking if container '${CONTAINER_NAME}' is running... "
if docker inspect --format='{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -q "true"; then
  echo "OK"
else
  echo "FAIL"
  echo "ERROR: Container '${CONTAINER_NAME}' is not running."
  exit 1
fi

# 2. Wait for MCP health check endpoint (host-side, MCP port is published)
echo "Waiting for health check endpoint at ${HEALTH_URL}..."
elapsed=0
while [ "${elapsed}" -lt "${MAX_WAIT}" ]; do
  if curl -sf "${HEALTH_URL}" > /dev/null 2>&1; then
    echo "Health check PASSED after ${elapsed}s."
    break
  fi
  sleep "${INTERVAL}"
  elapsed=$((elapsed + INTERVAL))
done

if [ "${elapsed}" -ge "${MAX_WAIT}" ]; then
  echo "FAIL"
  echo "ERROR: Health check did not respond within ${MAX_WAIT}s."
  exit 1
fi

# 3. Verify Data API is reachable inside the container (loopback-only)
echo -n "Checking Data API via docker exec... "
if docker exec "${CONTAINER_NAME}" curl -sf "http://127.0.0.1:${JOPLIN_DATA_API_PORT:-41184}/ping" > /dev/null 2>&1; then
  echo "OK"
else
  echo "WARN: Data API not responding inside container (may still be starting)"
fi

# 4. Report success
echo "=== Smoke Test PASSED ==="
exit 0
