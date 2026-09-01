# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

> **Live diff:** To see the full commit-level diff between releases, compare
> the release tags on GitHub (e.g. `v0.1.0...v0.2.0`).

## [0.2.0] - 2026-09-01

84 commits on `testing` since `origin/main` at branch cut.

### Added

- Combined single-container Dockerfile and entrypoint (`Dockerfile.combined`, `entrypoint-combined.sh`) — Joplin CLI + Data API + bash sync scheduler + MCP HTTP server in one container
- `MCP_HOST_PORT` environment variable for host-side MCP port mapping (container always listens on 3000)
- `JOPLIN_MASTER_PASSWORD` environment variable — declarative E2EE master password support on fresh container start ([`entrypoint-combined.sh`](entrypoint-combined.sh))
- `SQLITE_BUSY` retry logic with exponential backoff in `JoplinDataClient` for transient read errors during sync windows
- Sync failure diagnostics and connectivity probe (`check_sync_errors`)
- E2EE documentation section in README
- Container integration test infrastructure and test suites (notes-crud, folders-crud, search-tags, error-handling, mcp-connection)
- Unit tests for sync failure diagnostics, `SQLITE_BUSY` retry logic, and `check_sync_errors`
- CI workflow split: separate `unit-tests.yml` and `integration-tests.yml` workflows
- Release workflow (`release.yml`) and testing image publish (`publish-testing.yml`)
- Devcontainer setup and Makefile with self-documenting help target

### Changed

- Collapsed two-container production compose to single combined container (no more socat proxy)
- Replaced TypeScript `SyncManager` with a bash periodic-sync loop as the sole sync mechanism in the combined container
- Made sync behavior documentation and tool descriptions honest — scheduled sync only, no false write-triggered sync claims ([Fixes #13](https://github.com/gelse/joplin-mcp/issues/13))
- Bumped version to 0.2.0; fixed package metadata (repository, bugs, homepage URLs)

### Fixed

- Combined entrypoint review findings (drain loop, signal handling, log file paths)
- `tagNote`/`untagNote` to use correct Joplin Data API endpoints
- `SQLITE_BUSY` exhausted-path status code
- Sync error detection logic (inverted condition, unbounded log grep)
- SIGPIPE race in `check_sync_errors`
- 15 failing container integration tests across 4 test files
- Flaky `SQLITE_BUSY` tests with proper coverage
- Stale `test.yml` reference in SBOM.md
- Devcontainer forwarded port, permissions, and idempotent `groupadd`

### Removed

- Obsolete two-container build artifacts (`Dockerfile`, two-service `docker-compose.yml`)
- Legacy `test.yml` workflow (replaced by split unit/integration workflows)

## [0.1.0] - 2026-06-13

Initial development release.

- MCP server for Joplin exposing 17 tools (notes, folders, tags, search, sync)
- Joplin Data API HTTP client with token auth and session management
- Zod-validated input schemas for all tools
- TypeScript `SyncManager` serialized sync queue (legacy — superseded by bash scheduler in 0.2.0)
- Unit test suite with v8 coverage
- Container integration test infrastructure
- MIT license
