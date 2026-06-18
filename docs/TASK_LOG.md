# Task Log

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
