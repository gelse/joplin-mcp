# Task Log

## 2026-06-18T17:59:00Z — Exclude test container from default `docker compose up`

**Description**: Added `profiles: ["test"]` to the test service in [`docker-compose.yml`](docker-compose.yml:75). Running `docker compose up` no longer starts the test container; it starts only `joplin-core` and `joplin-mcp`. To include the test container, use `docker compose --profile test up`. Updated [`README.md`](README.md:235) test section to use `docker compose --profile test run --rm tests`. The GitHub Actions workflow ([`.github/workflows/test.yml`](.github/workflows/test.yml)) is unaffected — it uses `docker build`/`docker run` directly.

## 2026-06-18T14:45:00Z — Fix README.md inaccuracies after socat proxy architecture change

**Description**: Reviewed and corrected the README.md to accurately reflect the socat proxy architecture. Four inaccuracies fixed:

1. **Multi-stage builds claim (line 217)**: Updated to reflect that only `Dockerfile.mcp` uses multi-stage builds; `Dockerfile.core` is single-stage Debian-based.
2. **Architecture step 4 (line 266)**: Replaced non-existent `--host 0.0.0.0` flag reference with accurate socat proxy description (Data API on `127.0.0.1:41185`, socat exposes `0.0.0.0:41184`).
3. **socat proxy direction (lines 380-381)**: Corrected backwards proxy description and removed obsolete monolithic deployment reference.
4. **Startup pipeline step 4 (line 570)**: Replaced `joplin server start --host 0.0.0.0 --port` with accurate multi-step socat proxy setup description.

## 2026-06-18T16:05:00Z — Build, debug, and verify MCP component with list_notes tool returning creation dates

**Description**: Built the full two-container Docker stack, debugged multiple issues preventing the MCP server from functioning, added a `list_notes` tool with timestamp support, and verified end-to-end that notes are returned with `created_time` and `updated_time` fields.

**Issues encountered and fixed**:

1. **`@hono/node-server` ESM import failure**: Transitive dependency of `@modelcontextprotocol/sdk` not accessible via ESM imports in Docker's `--prod` pnpm install. Fixed by adding `@hono/node-server` (^1.19.0) and `hono` (^4.12.0) as direct dependencies in [`package.json`](package.json:31).

2. **`ERR_PNPM_OUTDATED_LOCKFILE`**: Changed `--frozen-lockfile` to `--no-frozen-lockfile` in [`Dockerfile.mcp`](Dockerfile.mcp) and [`Dockerfile.tests`](Dockerfile.tests) to allow pnpm to update the lockfile after dependency changes.

3. **Stateless transport single-use**: [`StreamableHTTPServerTransport`](src/mcp/server.ts:143) with `sessionIdGenerator: undefined` rejected all requests after the first one. Fixed by refactoring [`startMCPHttpServer()`](src/mcp/server.ts:124) to create a fresh `McpServer` + `StreamableHTTPServerTransport` per request.

4. **Missing timestamps in Joplin Data API responses**: The Joplin Data API only returns `created_time`/`updated_time` when the `?fields=` query parameter explicitly requests them. Added `fields` parameter to [`listNotes()`](src/data-client.ts:323) and [`getNote()`](src/data-client.ts:349).

5. **Duplicate `NOTE_FIELDS_READ` declaration**: Two separate `apply_diff` operations created duplicate constant definitions. Removed the duplicate, kept the original.

6. **Test failures (4 tests)**: Updated [`tools.test.ts`](tests/mcp/tools.test.ts) to expect `fields` array parameter on `getNote` calls, and [`tool-registry.test.ts`](tests/mcp/tool-registry.test.ts) tool count from 16 to 17.

**New tool added**:
- `list_notes` — registered in [`tool-registry.ts`](src/mcp/tool-registry.ts), schema in [`schemas.ts`](src/mcp/schemas.ts) (`ListNotesSchema`), handler in [`tools.ts`](src/mcp/tools.ts) using `NOTE_FIELDS_PAGE` constant. Returns paginated notes with `created_time`, `updated_time`, and other metadata.

**End-to-end verification**:
- `initialize` → MCP handshake succeeded, server identified as `joplin-api-mcp v0.1.0`
- `tools/list` → 17 tools registered (including `list_notes` as first tool)
- `tools/call list_notes` → returned 5 notes, each with `created_time`, `updated_time`, `id`, `title`, `body`, `parent_id`, `is_todo`, `todo_due`, `todo_completed`, `source_url`. Pagination confirmed with `has_more: true`.
- All 391 tests pass (0 failures, 14 skipped).

## 2026-06-18T14:40:00Z — Fix Data API network binding with socat TCP proxy, full stack verified

**Description**: The Joplin CLI Data API (ClipperServer.ts) hardcodes binding to `127.0.0.1`, making it unreachable from Container B (joplin-mcp) over the Docker bridge network. The `joplin server start` command has no `--host` flag to override this. Worked around this by shifting the Data API to an internal port (41185) and proxying `0.0.0.0:41184` → `127.0.0.1:41185` via `socat`.

**Root Cause**: [`ClipperServer.ts:145`](https://github.com/laurent22/joplin/blob/dev/packages/lib/ClipperServer.ts#L145) in the Joplin source hardcodes `this.server_.listen(this.port_, '127.0.0.1');`. The `joplin server start` command only accepts `--exit-early` and `--quiet` flags — no bind address override.

**Changes**:
- **`Dockerfile.core`**: Added `socat` to apt-get install packages
- **`entrypoint-core.sh`**: Complete rewrite of Data API startup block:
  1. Configure `joplin config api.port 41185` (internal port)
  2. Start `joplin server start` (binds to 127.0.0.1:41185 by default)
  3. Retry loop waiting for Data API health on 127.0.0.1:41185
  4. Start `socat TCP-LISTEN:41184,bind=0.0.0.0,fork,reuseaddr TCP:127.0.0.1:41185`
  5. Verify proxy via `curl http://127.0.0.1:41184/ping`
- **`.env`**: Added `JOPLIN_API_TOKEN` extracted from joplin-core container

**Verification**:
- joplin-core Data API healthy on internal 127.0.0.1:41185
- socat proxy verified reachable on 0.0.0.0:41184 (returns `JoplinClipperServer`)
- joplin-mcp connected successfully: `"status":"ok","version":"JoplinClipperServer"`
- All 16 MCP tools registered: list_notebooks, search_notes, read_note, read_notebook, read_multinote, read_tags, create_note, create_folder, edit_note, edit_folder, create_tag, tag_note, untag_note, delete_note, delete_folder, sync
- joplin-core periodic sync to joplin.gelse.net working correctly (initial sync passed, periodic loop active at 300s intervals)
- joplin-mcp health endpoint returns `{"status":"ok"}`

**Outcome**: Both containers operational end-to-end. joplin-core syncs with Joplin Server and exposes Data API on 0.0.0.0:41184. joplin-mcp proxies MCP requests through to the Data API.

## 2026-06-18T12:34:00Z — Clean up Dockerfile.core to single-stage build

**Description**: Removed the dead multi-stage TypeScript builder from `Dockerfile.core`. The core container only runs the globally-installed `joplin` CLI binary via `entrypoint-core.sh` — the compiled `dist/` and production `pnpm install` from the builder stage were never used. Reduced the Dockerfile from 75 lines (two stages) to 44 lines (single stage).

**Changes**: Removed Stage 1 (`FROM node:22-bookworm-slim AS builder` with `pnpm install`, `pnpm run build`) and all `COPY --from=builder` references in Stage 2. Kept apt-get dependencies, global joplin CLI install, user setup, entrypoint, healthcheck, and directory structure. Verified `docker-compose.yml` reference to `dockerfile: Dockerfile.core` remains valid.

## 2026-06-18T12:29:00Z — Remove Obsolete Files After Two-Container Modularization

**Description**: Identified and removed all obsolete files from the Joplin API project after it was modularized from a monolithic Docker setup into two containers (joplin-core and joplin-mcp).

### Files Deleted
- `Dockerfile` — original monolithic multi-stage Dockerfile, replaced by `Dockerfile.core` + `Dockerfile.mcp`
- `entrypoint.sh` — original monolithic entrypoint, replaced by `entrypoint-core.sh` + `entrypoint-mcp.sh`
- `src/server.ts` — 276-line monolithic entrypoint (spawned Data API, socat proxy, SyncManager, MCP on stdio), replaced by `src/mcp/entry.ts`
- `src/.env.example` — unreferenced duplicate of root `.env.example`
- `tests/server.test.ts` — 847-line test file (15 tests) for the deleted monolithic `src/server.ts`

### Files Updated (Reference Cleanup)
- **`README.md`** — ~13 edits: removed monolithic deployment section, updated MCP client config from stdio to HTTP, updated project structure tree (removed `server.test.ts`, `Dockerfile`, `entrypoint.sh`), updated key module descriptions
- **`SBOM.md`** — 4 edits: removed backward-compatibility note, updated supergateway section, updated mcp.json example from stdio to HTTP
- **`tests/TODO.md`** — removed `tests/server.test.ts` from audit table (TOTAL recalculated: 282→267, GENUINE: 257→246, WEAK: 7→6, GREEN-ONLY: 9→8), marked tasks 2, 3, 10 as OBSOLETE
- **`.devcontainer/devcontainer.json`** — updated postCreateCommand from `dist/server.js` to `dist/mcp/entry.js`
- **`package.json`** — updated `start` script from `dist/server.js` to `dist/mcp/entry.js`
- **`Dockerfile.core`** — updated description comment

### Verification
- `npx tsc --noEmit` passed with exit code 0
- Grep confirmed zero remaining stale references to deleted files in non-obsolete code
- `src/sync-manager.ts` confirmed NOT obsolete — actively used by Container B tools for write-through sync triggers

**Outcome**: All 5 obsolete files removed, all references updated, TypeScript compiles cleanly.

## 2026-06-18T16:15:00Z — Update README.md for list_notes tool and 16→17 tool count

**Description**: Updated README.md to reflect the new `list_notes` tool and updated all tool counts from 16 to 17.

### Changes

## 2026-06-18T17:29:00Z — Push all 13 commits to GitHub via SSH

**Description**: HTTPS push failed due to missing credentials (`could not read Username for 'https://github.com'`). SSH key was already configured and verified (`ssh -T git@github.com` returned `Hi gelse!`). Switched remote origin from `https://github.com/gelse/joplin-mcp.git` to `git@github.com:gelse/joplin-mcp.git` and pushed successfully.

- **Commits pushed**: 13 (e494046..d1e19a0)
- **Remote**: `git@github.com:gelse/joplin-mcp.git`
- Line 3: "16 tools" → "17 tools" in intro description
- Tool Overview table: Added `list_notes` row (after `list_notebooks`)
- Read Tools I/O Schemas table: Added `list_notes` row with input/output schema
- Project Structure comments: `schemas.ts` and `tools.ts` counts updated to 17
- Startup pipeline: "16 MCP tool handlers" → "17 MCP tool handlers"

**Outcome**: README.md now accurately reflects 17 tools with `list_notes` documented.

## 2026-06-18T16:32:00Z — Update PROMPT.md for list_notes tool, dependency changes, and 16→17 counts

**Description**: Updated PROMPT.md to reflect the new `list_notes` tool, added `@hono/node-server` and `hono` to the dependencies listing, and updated all tool counts from 16 to 17.

### Changes
- Line 5: "16 tools" → "17 tools" in Purpose
- Source File Map: `tool-registry.ts` (16→17), `tools.ts` (16→17), `schemas.ts` (16→17)
- Section header: "16 MCP Tools" → "17 MCP Tools"
- Read tools: "Read (6)" → "Read (7)", added `list_notes` row
- Dependencies JSON: Added `@hono/node-server` (^1.19.0) and `hono` (^4.12.0)

**Outcome**: PROMPT.md accurately reflects 17 tools, correct dependencies, and the new `list_notes` handler.
