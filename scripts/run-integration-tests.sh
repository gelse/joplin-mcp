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
docker compose -f "$COMPOSE_FILE" run --rm \
  -e "RUN_SYNC_LOCK_TESTS=0" \
  test-runner \
  pnpm vitest run --config vitest.config.container.ts \
  || TEST_EXIT=$?

# When RUN_SYNC_LOCK_TESTS=1, run the destructive repro in a SEPARATE
# vitest invocation targeting only the repro test file.  The destructive
# sync re-runs migrations from version 0 under the held exclusive lock,
# which kills the shared joplin-mcp container's Data API — running it in
# the same invocation as the other suites would cause sibling failures
# (fetch failed / ENOTFOUND joplin-mcp) due to file parallelism overlap.
# The repro now asserts M2 safe-behaviour and is expected to PASS.
# Propagate its exit code so the caller sees any regression.
REPRO_EXIT=0
if [ "${RUN_SYNC_LOCK_TESTS:-0}" -eq 1 ]; then
  echo "=== Running SQLITE_BUSY repro (destructive — runs in isolation) ==="
  docker compose -f "$COMPOSE_FILE" run --rm \
    -e "RUN_SYNC_LOCK_TESTS=1" \
    test-runner \
    pnpm vitest run --config vitest.config.container.ts \
      tests/container/sqlite-busy-repro.test.ts \
    || REPRO_EXIT=$?
  echo "=== Repro exit code: ${REPRO_EXIT} ==="
fi

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

if [ "${RUN_SYNC_LOCK_TESTS:-0}" -eq 1 ]; then
    if [ "$REPRO_EXIT" -eq 0 ]; then
        echo "SQLITE_BUSY repro passed — M2 safe-behaviour assertions verified."
    else
        echo "SQLITE_BUSY repro failed (exit code: ${REPRO_EXIT})."
    fi
fi

# Exit non-zero if either the regular suite or the repro failed.
if [ "$TEST_EXIT" -ne 0 ] || [ "$REPRO_EXIT" -ne 0 ]; then
    exit 1
fi
exit 0
