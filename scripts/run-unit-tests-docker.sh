#!/bin/bash
set -euo pipefail

# Runs the unit test suite inside Docker (Dockerfile.unittests) so it can be
# executed on machines without node/pnpm installed. Only `docker` is required.
#
# Guard: RUN_INTEGRATION_TESTS is deliberately never set here —
# tests/integration.test.ts self-skips unless it is truthy, so the container
# runs the unit suite only (vitest.config.ts: include tests/**/*.test.ts,
# exclude tests/container/**). No joplin-mcp service is started, the docker
# socket is not mounted, and the compose test stack is not used — that stack
# belongs to the container integration flow (scripts/run-integration-tests.sh).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DOCKERFILE="${PROJECT_DIR}/Dockerfile.unittests"
IMAGE_TAG="joplin-mcp-unittests"
REPORTS_DIR="${PROJECT_DIR}/reports/docker-test"

echo "=== Building unit-test image ==="
docker build -f "$DOCKERFILE" -t "$IMAGE_TAG" "$PROJECT_DIR"

echo "=== Running unit tests in container ==="
mkdir -p "$REPORTS_DIR"
TEST_EXIT=0
docker run --rm \
  -v "${REPORTS_DIR}:/app/reports" \
  "$IMAGE_TAG" \
  || TEST_EXIT=$?

echo "=== Test results ==="
if [ "$TEST_EXIT" -eq 0 ]; then
    echo "All unit tests passed!"
else
    echo "Unit tests failed (exit code: ${TEST_EXIT})"
fi
if [ -f "${REPORTS_DIR}/junit.xml" ]; then
    echo "JUnit report saved to: ${REPORTS_DIR}/junit.xml"
else
    echo "No JUnit report produced at: ${REPORTS_DIR}/junit.xml"
fi
echo "(Report files may be owned by root: the container runs as root.)"
exit "$TEST_EXIT"
