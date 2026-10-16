# Testing

Reader: a contributor running this repository's test suites — what each suite covers, how to run it, and what CI executes on which trigger.

## Unit suite

The unit suite runs against mocks — no Joplin instance required ([`vitest.config.ts`](vitest.config.ts)):

- Includes `tests/**/*.test.ts`, excludes `tests/container/**` ([`vitest.config.ts:7-8`](vitest.config.ts:7)); JUnit output lands in `reports/junit.xml` ([`vitest.config.ts:9-12`](vitest.config.ts:9))
- Coverage thresholds (70% statements, 60% branches, 70% functions, 70% lines, [`vitest.config.ts:17-22`](vitest.config.ts:17)) are enforced **only** when coverage is explicitly requested (`pnpm run test -- --coverage`); `make test`, `make docker-test`, and CI all run plain `vitest run`
- `tests/integration.test.ts` targets a real Data API and self-skips unless `RUN_INTEGRATION_TESTS` is truthy

Two ways to run it:

| Route | Requirement | Command |
| ----- | ----------- | ------- |
| Host | Node.js and pnpm | `make test` ([`Makefile:23`](Makefile:23)) |
| Docker | only docker + make | `make docker-test` ([`Makefile:53`](Makefile:53)) |

`make docker-test` ([`scripts/run-unit-tests-docker.sh`](scripts/run-unit-tests-docker.sh)) builds [`Dockerfile.unittests`](Dockerfile.unittests), tags it `joplin-mcp-unittests` ([`scripts/run-unit-tests-docker.sh:17`](scripts/run-unit-tests-docker.sh:17)), and runs the suite inside it — no Docker socket mount, no compose stack, and `RUN_INTEGRATION_TESTS` is never set. The JUnit report is bind-mounted out to `reports/docker-test/junit.xml`; the container runs as root, so the file is root-owned on the host (readable, but deleting it may need sudo) ([`scripts/run-unit-tests-docker.sh:42`](scripts/run-unit-tests-docker.sh:42)). The image's `CMD` is `pnpm run test` ([`Dockerfile.unittests:35`](Dockerfile.unittests:35)), so `docker run --rm joplin-mcp-unittests` also works ad hoc.

A second container route runs the same suite via the profile-gated `test` service in [`docker-compose.yml`](docker-compose.yml), built from [`Dockerfile.tests`](Dockerfile.tests) with `./reports` bind-mounted for persistent reports.

**Structural shell tests:** the shell harnesses under [`tests/`](tests) include a layer that asserts entrypoint *text* rather than behaviour — duplicated function bodies are extracted verbatim by these tests and must be kept in lockstep (the entrypoint marks each duplicated block with a `LOCKSTEP` comment, e.g. [`entrypoint-combined.sh:182-185`](entrypoint-combined.sh:182)). Asserting text is an intentional, accepted trade-off: it keeps those safety-net tests independent of the entrypoint's runtime, at the price of needing manual updates when the marked blocks change. Behaviour itself is covered by the container integration suites below.

## Container integration tests

End-to-end tests run the full MCP stack in Docker using the integration-test stack ([`docker-compose.test.yml`](docker-compose.test.yml)), built from the same [`Dockerfile.combined`](Dockerfile.combined) as production. The combined container runs with dummy sync credentials — no real Joplin Server is needed for the default suite; the API token is auto-extracted from the CLI config at startup.

```bash
make test-integration
# or
./scripts/run-integration-tests.sh
```

Covered: MCP connection and tool discovery (17 tools), note CRUD, folder CRUD, search and tag operations, error handling and validation. Reports: `reports/container/junit.xml` plus container logs in `reports/container/`.

The runner script resolves the `joplin-mcp` service's container ID from the compose project (`docker compose ps -q -a`) and exports it as `JOPLIN_CONTAINER` ([`scripts/run-integration-tests.sh:26-31`](scripts/run-integration-tests.sh:26)), so the stack never collides with a locally running dev stack or concurrent CI jobs. If you run vitest directly without the script, set `JOPLIN_CONTAINER` yourself — the built-in `joplin-mcp` default only resolves if a container is actually named `joplin-mcp`.

### Docker socket privilege warning

The `test-runner` service mounts the host Docker socket ([`docker-compose.test.yml:130-134`](docker-compose.test.yml:130)) so tests can `docker exec` into the stack. That mount grants **root-equivalent control over the host Docker daemon** (any image, any mount, host filesystem access via bind mounts). It is acceptable only for these throwaway test stacks — never replicate it in a non-test compose file, and note that the repro jobs are therefore manually dispatched only.

### SQLITE_BUSY repro test

`RUN_SYNC_LOCK_TESTS=1 ./scripts/run-integration-tests.sh` runs a dedicated repro of the destructive `SQLITE_BUSY` migration bug: a Node process inside the container holds an exclusive SQLite write lock (outlasting the CLI's ~43 s retry window at 120 s), a bypass `joplin sync` is triggered under the lock, and the assertions verify that the destructive-migration signatures appear in the captured log, that `check_sync_danger`'s regex detects them, and that no secondary corruption occurs. The bypass sync deliberately sidesteps the entrypoint's flock/halt gate — that remains a documented non-goal — so the test is destructive by design and runs as a **separate vitest invocation** after the regular suite (the destructive sync kills the shared container's Data API).

### E2EE encrypted-titles repro test

`RUN_E2EE_REPRO_TESTS=1 ./scripts/run-integration-tests.sh` runs the E2EE repro against a real `joplin/server:latest` — requirements, the `E2EE_REPRO_SERVER_URL` override (default `http://joplin-server:22300`), the `FIXTURE_NOT_SYNCED` anti-vacuous gate, and the compose profile `e2ee-repro` are documented in [`docs/e2ee.md#e2ee-reproduction-test`](docs/e2ee.md#e2ee-reproduction-test).

## CI

Four GitHub Actions workflows in [`.github/workflows/`](.github/workflows):

| Workflow | Trigger | What it does |
| -------- | ------- | ------------ |
| [`unit-tests.yml`](.github/workflows/unit-tests.yml) | push to `main`; PRs to `main` and `testing` ([`.github/workflows/unit-tests.yml:3-7`](.github/workflows/unit-tests.yml:3)) | pnpm install (`--frozen-lockfile`) + `pnpm test` on Ubuntu |
| [`integration-tests.yml`](.github/workflows/integration-tests.yml) | PRs to `main` and `testing`; manual `workflow_dispatch` (which also unlocks the repro jobs) ([`.github/workflows/integration-tests.yml:3-21`](.github/workflows/integration-tests.yml:3)) | Container integration tests via [`scripts/run-integration-tests.sh`](scripts/run-integration-tests.sh) |
| [`publish-testing.yml`](.github/workflows/publish-testing.yml) | push to `testing` ([`.github/workflows/publish-testing.yml:7-9`](.github/workflows/publish-testing.yml:7)) | Unit **and** integration tests, then uploads `ghcr.io/gelse/joplin-mcp:latest-testing` for `linux/amd64,linux/arm64` ([`.github/workflows/publish-testing.yml:74`](.github/workflows/publish-testing.yml:74)) — upload only, no GitHub release, no versioned tags |
| [`release.yml`](.github/workflows/release.yml) | release published; manual `workflow_dispatch` ([`.github/workflows/release.yml:3-6`](.github/workflows/release.yml:3)) | Verifies lockfile reproducibility, then builds [`Dockerfile.combined`](Dockerfile.combined) for `linux/amd64,linux/arm64` ([`.github/workflows/release.yml:64`](.github/workflows/release.yml:64)) and pushes semver + `latest` tags |

The `publish-testing.yml` `publish` job runs only when both of its test jobs succeed (`needs: [unit-tests, integration-tests]`); `release.yml` remains the sole owner of versioned tags and the `latest` tag.

> **Branch protection:** if branch protection is configured on `main`, add the required status checks `unit-tests` and `integration-tests` (an earlier `test` job name no longer exists).

## Where to read next

- Local commands and project layout: [`docs/development.md`](docs/development.md)
- What the integration stack deploys: [`docs/architecture.md`](docs/architecture.md)
- The E2EE behaviour the repro test guards: [`docs/e2ee.md`](docs/e2ee.md)
