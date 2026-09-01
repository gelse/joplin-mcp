#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${PROJECT_DIR}/docker-compose.test.yml"
REPORTS_DIR="${PROJECT_DIR}/reports/container"

echo "=== Building test images ==="
docker compose -f "$COMPOSE_FILE" build

echo "=== Starting test stack ==="
docker compose -f "$COMPOSE_FILE" up -d joplin-mcp

echo "=== Waiting for joplin-mcp to become healthy ==="
docker compose -f "$COMPOSE_FILE" up -d --wait joplin-mcp

echo "=== Running container integration tests ==="
mkdir -p "$REPORTS_DIR"
TEST_EXIT=0
docker compose -f "$COMPOSE_FILE" run --rm test-runner \
  pnpm vitest run --config vitest.config.container.ts \
  || TEST_EXIT=$?

echo "=== Collecting logs ==="
docker compose -f "$COMPOSE_FILE" logs joplin-mcp > "${REPORTS_DIR}/joplin-mcp.log" 2>&1 || true

echo "=== Tearing down test stack ==="
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans

echo "=== Test results ==="
if [ "$TEST_EXIT" -eq 0 ]; then
    echo "All container integration tests passed!"
else
    echo "Container integration tests failed (exit code: ${TEST_EXIT})"
    echo "Check reports in: ${REPORTS_DIR}"
fi

exit "$TEST_EXIT"
