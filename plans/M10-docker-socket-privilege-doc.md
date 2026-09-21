# M10 — Document the `docker.sock` Root-Privilege Mount

> Source: [`docs/code-review-testing-2026-09-21.md`](../docs/code-review-testing-2026-09-21.md)
> finding **S4** (SUGGESTION).

## Problem

[`docker-compose.test.yml:36`](../docker-compose.test.yml:36) mounts
`/var/run/docker.sock` into the `test-runner` service. Mounting the host
Docker socket grants the container **root-equivalent control over the host
daemon** (any image, any mount, host filesystem access via bind mounts).

The mount is necessary for the repro harness
([`tests/container/sqlite-busy-repro.test.ts`](../tests/container/sqlite-busy-repro.test.ts:31)
needs `docker exec` into the sibling `joplin-mcp` container) and is confined
to the test compose file plus the manually dispatched CI job
(`workflow_dispatch` gate in
[`.github/workflows/integration-tests.yml:50`](../.github/workflows/integration-tests.yml:50)),
but nothing at the mount site itself states the privilege implication. The
CI workflow comment partially covers it — one line at the mount site completes
the picture. (The existing two-line comment at
[`docker-compose.test.yml:35-36`](../docker-compose.test.yml:35) explains the
*purpose*, not the *risk*.)

## Goal

Make the privilege trade-off explicit where the mount is defined and where
developers read about the test setup, so nobody copies the pattern into a
non-test compose file unawares.

## Proposed Approach

Documentation only:

- [`docker-compose.test.yml`](../docker-compose.test.yml:35): extend the
  existing comment above the socket mount:
  ```yaml
  # Docker socket for container-to-container docker exec (sqlite-busy-repro tests).
  # WARNING: this grants the test-runner ROOT-EQUIVALENT control over the host
  # Docker daemon. Test infrastructure only — never replicate in a production
  # compose file.
  ```
- [`.github/workflows/integration-tests.yml`](../.github/workflows/integration-tests.yml:6):
  add one comment line near the `workflow_dispatch` trigger noting the gated
  job mounts the host Docker socket into the test runner (root-equivalent) and
  is therefore manual-dispatch only.
- [`README.md`](../README.md): in the sqlite-busy repro section (around line
  200), add a short caveat paragraph: the gated test run mounts the host
  Docker socket into the test-runner container — a root-equivalent credential —
  and the job is manually dispatched only.

## Acceptance Criteria

- The socket mount in `docker-compose.test.yml` carries an explicit
  root-equivalent-privilege warning.
- The CI workflow notes why the job is manual-dispatch only.
- README mentions the socket privilege in the repro-test section.
- No functional changes to any compose file, workflow, or test.

## Verification

1. `docker compose -f docker-compose.test.yml config` still parses (YAML valid
   after comment edits).
2. `grep -n "ROOT-EQUIVALENT\|root-equivalent" docker-compose.test.yml
   .github/workflows/integration-tests.yml README.md` finds all three notes.
3. No workflow behavior change: the job's trigger conditions are untouched.

## Non-goals

- Removing the socket mount or replacing it with a socket-proxy (the repro
  harness genuinely needs `docker exec` into a sibling; a proxy would be
  disproportionate for test infra).
- Changing the production [`docker-compose.yml`](../docker-compose.yml) — it
  correctly has no socket mount.
