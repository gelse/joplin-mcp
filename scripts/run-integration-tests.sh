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

echo "=== Resolving joplin-mcp container ID from the compose project ==="
# `docker exec` accepts container IDs as well as names. Resolving the ID from
# the compose project keeps the repro suite working even when another stack
# owns the fixed "joplin-mcp" name (the test compose no longer pins one).
# `ps -q -a` also resolves a stopped service container. On empty resolution,
# fail fast: silently falling back to the "joplin-mcp" name could target an
# unrelated stack (e.g. a running dev container), and the repro suite is
# destructive to whatever container it targets.
JOPLIN_CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -q -a joplin-mcp)"
if [ -z "$JOPLIN_CONTAINER_ID" ]; then
  echo "ERROR: could not resolve joplin-mcp container from compose project $COMPOSE_FILE" >&2
  exit 1
fi
export JOPLIN_CONTAINER="$JOPLIN_CONTAINER_ID"

echo "=== Running container integration tests ==="
mkdir -p "$REPORTS_DIR"
TEST_EXIT=0
docker compose -f "$COMPOSE_FILE" run --rm \
  -e "RUN_SYNC_LOCK_TESTS=0" \
  -e "JOPLIN_CONTAINER=${JOPLIN_CONTAINER}" \
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
    -e "JOPLIN_CONTAINER=${JOPLIN_CONTAINER}" \
    test-runner \
    pnpm vitest run --config vitest.config.container.ts \
      tests/container/sqlite-busy-repro.test.ts \
    || REPRO_EXIT=$?
  echo "=== Repro exit code: ${REPRO_EXIT} ==="
fi

# When RUN_E2EE_REPRO_TESTS=1, bring up the e2ee-repro profile (real
# Joplin Server + one-shot seed container) and run the E2EE repro test
# in a SEPARATE vitest invocation. The repro needs the seeder to have
# completed first; running it inside the same invocation as the regular
# suite could race the seeder or be incomplete if PROFILE gating is in
# use. Mirror the destructive-isolation rationale for the sqlite-busy-repro.
E2EE_REPRO_EXIT=0
if [ "${RUN_E2EE_REPRO_TESTS:-0}" -eq 1 ]; then
  # Real-server credentials for the e2ee-repro stack (M1-T1 §9.4 env
  # contract): the `${VAR:-default}` interpolation in docker-compose.test.yml
  # substitutes these into joplin-mcp, joplin-server (DEFAULT_ADMIN_PASSWORD)
  # and joplin-e2ee-seed. Set ONLY inside this branch so the default path
  # keeps the dummy-server behavior byte-identical. JOPLIN_MASTER_PASSWORD is
  # hard-required by the seeder (tests/container/fixtures/e2ee-seed.sh:22);
  # `test-password` is the value M1-T2 verified against the pinned CLI image.
  # joplin-mcp was already started above (before the seed) with the dummy
  # defaults, and its startup initial sync has already run — recreating it
  # below with these values is what points it at the seeded real server.
  #
  # E2EE_REPRO_SERVER_URL is an opt-in override for this URL: set it to a
  # bad/unreachable host (e.g. http://nonexistent.example.invalid:1) to point
  # the recreated joplin-mcp at a server it cannot reach — proving the
  # repro's FIXTURE_NOT_SYNCED anti-vacuous gate
  # (tests/container/e2ee-encrypted-titles-repro.test.ts:246-251) can actually
  # fail. Unset — the default — yields byte-identical behavior (the same URL
  # as before the override existed). A dedicated var, not a pre-set
  # JOPLIN_SERVER_URL: compose interpolates JOPLIN_SERVER_URL from this shell
  # at EVERY `up` (docker-compose.test.yml:11), including the pre-seed
  # `up -d joplin-mcp` above — honoring a pre-set value would poison that
  # container too — whereas E2EE_REPRO_SERVER_URL is read only here, so it
  # reaches only the --force-recreate below. The credentials below stay
  # exactly as they are even for a bad URL: bad URL + real credentials is
  # precisely the Step-3b scenario the gate must survive.
  export JOPLIN_SERVER_URL="${E2EE_REPRO_SERVER_URL:-http://joplin-server:22300}"
  export JOPLIN_USERNAME="admin@localhost"
  export JOPLIN_PASSWORD="admin"
  export JOPLIN_MASTER_PASSWORD="test-password"

  echo "=== Starting E2EE repro profile (real server + seed) ==="
  docker compose -f "$COMPOSE_FILE" --profile e2ee-repro up -d joplin-server \
    || { echo "ERROR: could not start joplin-server — aborting E2EE repro" >&2; E2EE_REPRO_EXIT=1; }

  if [ "${E2EE_REPRO_EXIT}" -eq 0 ]; then
    echo "=== Waiting for joplin-server to be healthy ==="
    docker compose -f "$COMPOSE_FILE" --profile e2ee-repro up -d --wait joplin-server \
      || { echo "ERROR: joplin-server never became healthy — aborting E2EE repro" >&2; E2EE_REPRO_EXIT=1; }
  fi

  if [ "${E2EE_REPRO_EXIT}" -eq 0 ]; then
    echo "=== Running one-shot seeder ==="
    docker compose -f "$COMPOSE_FILE" --profile e2ee-repro run --rm joplin-e2ee-seed || {
      echo "ERROR: joplin-e2ee-seed failed — aborting E2EE repro" >&2
      E2EE_REPRO_EXIT=1
    }
  fi

  # Ordering: joplin-mcp came up at the top of this script against the dummy
  # server and its one startup initial sync (entrypoint-combined.sh initial
  # `joplin sync`, before the MCP server starts) has already happened, with
  # nothing to download. SYNC_INTERVAL_SECONDS=9999 means it will never
  # re-sync on its own, so the seeded ciphertext would never arrive. Recreate
  # it: `up` picks up the changed environment above and the fresh container
  # performs a new startup initial sync against the now-seeded real server —
  # the bug's download path. --no-deps because the seeder already ran to
  # completion above (a dependency re-run here would double-seed and risks
  # the server's per-IP login rate limit) and joplin-server health was
  # already established by the explicit `up --wait joplin-server` above.
  # A plain `restart` would NOT pick up the new environment.
  if [ "${E2EE_REPRO_EXIT}" -eq 0 ]; then
    echo "=== Recreating joplin-mcp against the seeded real server ==="
    docker compose -f "$COMPOSE_FILE" --profile e2ee-repro up -d --force-recreate --wait --no-deps joplin-mcp \
      || { echo "ERROR: joplin-mcp did not become healthy against the real server — aborting E2EE repro" >&2; E2EE_REPRO_EXIT=1; }
  fi

  if [ "${E2EE_REPRO_EXIT}" -eq 0 ]; then
    echo "=== Resolving joplin-mcp container ID (with profile) ==="
    # Guarded so a `compose ps` failure cannot abort the script (set -e)
    # before the profile-aware teardown runs — that would leak the stack.
    JOPLIN_CONTAINER_ID="$(docker compose -f "$COMPOSE_FILE" ps -q -a joplin-mcp)" || {
      echo "ERROR: failed to query compose project $COMPOSE_FILE for joplin-mcp (e2ee-repro profile)" >&2
      E2EE_REPRO_EXIT=1
    }
    if [ "${E2EE_REPRO_EXIT}" -eq 0 ]; then
      if [ -z "$JOPLIN_CONTAINER_ID" ]; then
        echo "ERROR: could not resolve joplin-mcp container from compose project $COMPOSE_FILE (e2ee-repro profile)" >&2
        E2EE_REPRO_EXIT=1
      else
        export JOPLIN_CONTAINER="$JOPLIN_CONTAINER_ID"
      fi
    fi
  fi

  if [ "${E2EE_REPRO_EXIT}" -eq 0 ]; then
    echo "=== Running E2EE encrypted-titles repro (separate vitest invocation) ==="
    # No JOPLIN_CONTAINER -e flag here on purpose: its count on docker compose
    # run invocations is pinned at exactly 2 by
    # tests/integration-runner-config.test.ts (M11); the value reaches vitest
    # via the test-runner service's compose `environment:` block instead.
    docker compose -f "$COMPOSE_FILE" run --rm \
      -e "RUN_E2EE_REPRO_TESTS=1" \
      test-runner \
      pnpm vitest run --config vitest.config.container.ts \
        tests/container/e2ee-encrypted-titles-repro.test.ts \
      || E2EE_REPRO_EXIT=$?
    echo "=== E2EE repro exit code: ${E2EE_REPRO_EXIT} ==="
  fi
fi

echo "=== Collecting logs ==="
docker compose -f "$COMPOSE_FILE" logs joplin-mcp > "${REPORTS_DIR}/joplin-mcp.log" 2>&1 || true

echo "=== Tearing down test stack ==="
if [ "${RUN_E2EE_REPRO_TESTS:-0}" -eq 1 ]; then
  # --profile is REQUIRED here: without it Compose excludes the profile
  # services from the teardown model and leaves joplin-server, the seeder
  # container and the joplin_seed_data volume behind (verified empirically on
  # compose 5.5.1: a plain `down -v --remove-orphans` after an e2ee-repro run
  # removed joplin-mcp but NOT the profile services/volume). The default
  # branch below stays byte-identical to the pre-M1-T4 line.
  docker compose -f "$COMPOSE_FILE" --profile e2ee-repro down -v --remove-orphans
else
  docker compose -f "$COMPOSE_FILE" down -v --remove-orphans
fi

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

if [ "${RUN_E2EE_REPRO_TESTS:-0}" -eq 1 ]; then
    if [ "$E2EE_REPRO_EXIT" -eq 0 ]; then
        echo "E2EE encrypted-titles repro passed — M1 safe-behaviour verified (RED on current code; GREEN after M2)."
    else
        echo "E2EE encrypted-titles repro failed (exit code: ${E2EE_REPRO_EXIT})."
    fi
fi

# Exit non-zero if any of the regular suite, the SQLITE_BUSY repro, or the
# E2EE repro failed.
if [ "$TEST_EXIT" -ne 0 ] || [ "$REPRO_EXIT" -ne 0 ] || [ "${E2EE_REPRO_EXIT:-0}" -ne 0 ]; then
    exit 1
fi
exit 0
