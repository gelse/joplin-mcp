# Development

Reader: a contributor setting up the project locally — the commands available, the repository layout, and what each root deployment file does.

## Commands

Node.js and pnpm are required on the host for the routes below (for the Docker-only route, see [`docs/testing.md`](docs/testing.md)).

| Command | What it does ([`package.json:34-42`](package.json:34)) |
| ------- | ------------------------------------------------------- |
| `pnpm install` | Install dependencies |
| `pnpm dev` | Run in development mode with hot reload (`tsx watch src/mcp/entry.ts`) |
| `pnpm build` | Compile TypeScript (`tsc -p tsconfig.build.json`) |
| `pnpm start` | Run the compiled server (`node dist/mcp/entry.js`) |
| `pnpm test` | Run tests (`vitest run`) |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm lint` | Lint source code (eslint) |
| `pnpm format` | Format source code (prettier --write) |

Note that `pnpm dev` / `pnpm start` run the MCP HTTP server process only — they expect `JOPLIN_CORE_URL` and `JOPLIN_API_TOKEN` to point at an already-running Data API. The full container (Data API + sync loop + MCP) is started with `make docker-up` / `docker compose up -d`.

## Makefile targets

All targets from [`Makefile`](Makefile): `help`, `install`, `build`, `dev`, `start`, `test`, `test-watch`, `lint`, `format`, `docker-build`, `docker-up`, `docker-down`, `clean`, `smoke-test`, `test-integration`, `docker-test`, `measure-initial-sync`.

The ones you will use most: `make test` (unit suite on host), `make docker-test` (unit suite without host Node/pnpm), `make test-integration` (container integration stack), `make smoke-test` (running-container smoke check), `make measure-initial-sync` (initial-sync throughput against a live server).

## Project structure

```
src/
├── config.ts              # Zod-based environment config parsing
├── logger.ts              # Pino structured logger
├── cli-executor.ts        # Joplin CLI subprocess wrapper
├── sync-manager.ts        # Serialized sync queue orchestrator (legacy — not wired in the combined container; sync is handled by the bash loop)
├── data-client.ts         # Joplin Data API HTTP client (27 public methods; 26 excluding clearToken() — token auth)
├── api-types.ts           # TypeScript type definitions for the Joplin API
├── errors.ts              # Typed error class hierarchy
├── guarded-string.ts      # Secure string wrapper (prevents accidental secret leakage)
├── pagination.ts          # Pagination helpers (clampLimit, fetchAllPages)
└── mcp/
    ├── entry.ts           # MCP HTTP server entrypoint
    ├── server.ts          # MCP server setup (stdio + StreamableHTTP transport)
    ├── schemas.ts         # Zod validation schemas for all 17 tools
    ├── tools.ts           # 17 tool handler implementations
    └── tool-registry.ts   # Tool registration and dispatch
tests/
├── cli-executor.test.ts   # CLI executor tests
├── config.test.ts         # Config parser tests
├── container/             # Container integration tests (vitest.config.container.ts; make test-integration)
├── data-client.test.ts    # Data API client tests
├── docker-test-config.test.ts        # Structural guards for make docker-test
├── errors.test.ts         # Error class hierarchy tests
├── integration-runner-config.test.ts # Structural guards for the integration-test runner
├── integration.test.ts    # Integration tests against a live Data API (opt-in via RUN_INTEGRATION_TESTS)
├── logger.test.ts         # Logger tests
├── pagination.test.ts     # Pagination helper tests
├── sync-manager.test.ts   # Sync manager tests
├── sync-followed-by-decrypt.test.ts    # Every-sync-followed-by-decrypt contract test
├── periodic-sync-e2ee-decrypt.test.ts  # Periodic loop E2EE decrypt structural test
├── test-*.sh              # Shell harnesses for entrypoint sync-safety and E2EE functions
└── mcp/
    ├── schemas.test.ts     # Zod schema validation tests
    ├── server.test.ts      # MCP server lifecycle tests
    ├── tool-registry.test.ts # Tool registration & dispatch tests
    └── tools.test.ts       # Tool handler tests
docs/                      # Topic documentation (architecture, e2ee, tools, sync, security, testing, development, troubleshooting, migration)
scripts/
├── smoke-test.sh              # Docker container smoke test (checks container up + Data API /ping)
├── run-integration-tests.sh   # Container integration test runner (make test-integration)
├── run-unit-tests-docker.sh   # Unit tests in Docker without host Node/pnpm (make docker-test)
└── measure-initial-sync.sh    # Initial sync throughput measurement (requires live Joplin Server)
```

**`sync-manager.ts` is legacy:** the combined container builds its tool context without a `SyncManager` ([`src/mcp/entry.ts:50-55`](src/mcp/entry.ts:50)) — all syncing is owned by the entrypoint's bash loop (see [`docs/architecture.md#component-map`](docs/architecture.md#component-map)). The class and its tests remain for the stdio-era entry points.

## Root deployment files

| File | Purpose |
| ---- | ------- |
| [`Dockerfile.combined`](Dockerfile.combined) | Production: combined Joplin CLI + Data API + MCP HTTP server |
| [`Dockerfile.tests`](Dockerfile.tests) | Test runner image for both the compose `test` service (unit suite) and the integration stack's `test-runner` service |
| [`Dockerfile.unittests`](Dockerfile.unittests) | Self-contained unit-test image used by `make docker-test` (no host Node/pnpm needed) |
| [`entrypoint-combined.sh`](entrypoint-combined.sh) | Production entrypoint: Data API + sync loop + MCP server with graceful shutdown |
| [`docker-compose.yml`](docker-compose.yml) | Single-service orchestration with healthchecks |
| [`docker-compose.test.yml`](docker-compose.test.yml) | Integration-test stack (uses `Dockerfile.combined`, used by `make test-integration`) |

## Where to read next

- How the deployed container is structured: [`docs/architecture.md`](docs/architecture.md)
- Running the test suites: [`docs/testing.md`](docs/testing.md)
