# M11 — Fixed `container_name` Blocks Parallel Compose Stacks

> Source: [`docs/code-review-testing-2026-09-21.md`](../docs/code-review-testing-2026-09-21.md)
> finding **S5** (SUGGESTION).

## Problem

[`docker-compose.test.yml:7`](../docker-compose.test.yml:7) hardcodes
`container_name: joplin-mcp` for the test stack. A fixed container name:

- collides with any other compose project using the same name — including a
  locally running stack from [`docker-compose.yml`](../docker-compose.yml:23)
  (which sets the same name at line 24), so the test stack cannot come up
  alongside a dev instance;
- collides with concurrent CI jobs on the same runner.

The name exists so the repro test can `docker exec` by name:
[`tests/container/sqlite-busy-repro.test.ts:31`](../tests/container/sqlite-busy-repro.test.ts:31)
defaults to `joplin-mcp` (`process.env['JOPLIN_CONTAINER'] || 'joplin-mcp'`).

## Goal

Derive the target container from the compose project instead of a fixed name,
so parallel/stacked runs are possible while keeping the current default
behavior for single-stack users.

## Proposed Approach

1. [`scripts/run-integration-tests.sh`](../scripts/run-integration-tests.sh):
   after `docker compose -f docker-compose.test.yml up`, resolve the container
   ID from the compose project and export it for the vitest process:
   ```bash
   JOPLIN_CONTAINER_ID="$(docker compose -f docker-compose.test.yml ps -q joplin-mcp)"
   export JOPLIN_CONTAINER="${JOPLIN_CONTAINER_ID:-joplin-mcp}"
   ```
   `docker exec` accepts IDs as well as names, so the test code needs no change
   to work with the ID.
2. [`docker-compose.test.yml`](../docker-compose.test.yml:7): remove
   `container_name: joplin-mcp` **or** keep it behind an env override
   (`container_name: ${JOPLIN_TEST_CONTAINER_NAME:-joplin-mcp}`) — removing is
   cleaner; compose then generates a project-scoped name and `ps -q` resolves
   it unambiguously.
3. [`tests/container/sqlite-busy-repro.test.ts`](../tests/container/sqlite-busy-repro.test.ts:31):
   no change required — `JOPLIN_CONTAINER` is already env-configurable with a
   `joplin-mcp` fallback; the runner script now always supplies it.
4. [`README.md`](../README.md): update the repro-test run instructions to
   mention `JOPLIN_CONTAINER` is auto-resolved by the runner script, and that
   the fixed container name no longer blocks parallel stacks.

## Acceptance Criteria

- `docker compose -f docker-compose.test.yml up` succeeds even while another
  project runs a container named `joplin-mcp`.
- The gated repro suite works unchanged via the runner script
  (`RUN_SYNC_LOCK_TESTS=1 ./scripts/run-integration-tests.sh`), with the
  target container resolved from the compose project.
- Without the runner script (direct vitest invocation), the existing
  `JOPLIN_CONTAINER` env override still works and the `joplin-mcp` name
  fallback is preserved.
- MCP_URL wiring (`http://joplin-mcp:3000/` at
  [`docker-compose.test.yml:25`](../docker-compose.test.yml:25)) is unaffected:
  compose service-name DNS is project-scoped and independent of
  `container_name`.

## Verification

1. Start a throwaway container named `joplin-mcp` (`docker run -d --name
   joplin-mcp busybox sleep 300`), then run the **ungated** suite via the
   runner script → all stacks up, tests green; remove the throwaway after.
2. Run the gated repro once (devcontainer/CI) → mechanism validation still
   passes (LOCK_HELD awaited, probe busy), confirming `docker exec` via the
   resolved ID works end to end.
3. `./scripts/run-integration-tests.sh` without `RUN_SYNC_LOCK_TESTS` →
   regular suite green, repro skipped.

## Non-goals

- Renaming the production container in [`docker-compose.yml`](../docker-compose.yml:24).
- Solving host-port collisions for parallel stacks (the MCP port mapping in
  the test compose is not published, so none exists today).
- Changing how `MCP_URL` is resolved.
