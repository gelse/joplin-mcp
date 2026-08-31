# PROMPT.md — Joplin API MCP Server (AI-Optimized Context)

## Identity
- **Name**: `joplin-api-mcp` (npm: `joplin-api-mcp`)
- **Purpose**: MCP server exposing Joplin note-taking (notes, folders, tags, search, sync) to AI assistants via 17 tools over StreamableHTTP transport.
- **License**: MIT
- **Node**: `>=22.0.0`, ESM (`"type": "module"`)
- **Lang**: TypeScript 5.7, compiled via `tsc -p tsconfig.build.json`
- **Entry**: `src/mcp/entry.ts` → `dist/mcp/entry.js`

## Architecture: Single-Container (Docker Production) / Single-Process (Native)

### Production: `joplin-mcp` (single combined container)
- Runs Joplin CLI + Data API (loopback `127.0.0.1:41184`), bash sync scheduler, and Node.js MCP HTTP server in one container
- `entrypoint-combined.sh`: starts Data API, periodic sync loop (own process group via `setsid`), MCP server; liveness monitor via `wait -n`
- Data API binds to `127.0.0.1:41184` (loopback-only) — no socat proxy
- MCP server on port 3000 (StreamableHTTPServerTransport, sessionless: `sessionIdGenerator: undefined`)
- Auto-extracts API token from Joplin CLI config (or honours `JOPLIN_API_TOKEN` override)
- `JOPLIN_CORE_URL` set internally to `http://127.0.0.1:41184` (not operator-facing)
- Graceful shutdown on SIGTERM: drain sync loop, stop MCP, stop Data API, final sync, reentrancy guard
- Persistent SQLite DB at `/home/joplin/.config/joplin` (Docker volume: `joplin_data`)
- Healthcheck: `curl 127.0.0.1:41184/ping && curl 127.0.0.1:3000/health` (90s start-period)

### Integration-Test Stack (retained two-container topology)
- Uses `Dockerfile.core` + `Dockerfile.mcp` via `docker-compose.test.yml` (not used in production)
- Container A (`joplin-core`): `entrypoint-core.sh` + socat proxy on port 41184
- Container B (`joplin-mcp`): `entrypoint-mcp.sh` → `node dist/mcp/entry.js`, connects to Container A via `JOPLIN_CORE_URL`

## Source File Map

| File | Role |
|------|------|
| `src/config.ts` | Zod env parser: `JOPLIN_SERVER_URL`, `JOPLIN_USERNAME`, `JOPLIN_PASSWORD`, `JOPLIN_API_TOKEN`, `JOPLIN_CORE_URL`, `JOPLIN_DATA_API_PORT`(41184), `LOG_LEVEL`(info), `SYNC_INTERVAL_SECONDS`(300); `MCP_PORT`(3000) read directly from `process.env` in `src/mcp/entry.ts`, unvalidated |
| `src/logger.ts` | Pino structured logger (`pino` + `pino-pretty`), `createLogger(config)` |
| `src/guarded-string.ts` | `GuardedString` class — `#value` private field, `toString()`/`toJSON()` return `'[REDACTED]'`, only `.value` exposes raw |
| `src/errors.ts` | Hierarchy: `ConfigError`, `DataApiError(statusCode,responseBody?)`, `NotFoundError(404)`, `ConflictError(409)`, `ValidationError(400)`, `AuthError(401)`, `FatalError(cause?,exitCode)` |
| `src/api-types.ts` | TS interfaces: `Note`, `Folder`, `Tag`, `Resource`, `NoteTag`, `Event`, `SearchResult`, `PingResponse`, `PaginatedResponse<T>`, payload types for CRUD |
| `src/pagination.ts` | `clampLimit(n)` → 1–100, `buildPageParam(p)` → `&page=N`, `fetchAllPages(fn)` → loop `has_more` |
| `src/data-client.ts` | `JoplinDataClient` — HTTP client for Joplin Data API; 26 methods; auth via `POST /auth` (Bearer token, 55min expiry, 60s proactive refresh, 401 retry); concurrency limiter (max 5); ID validation (`/^[a-zA-Z0-9_-]+$/`) |
| `src/cli-executor.ts` | `CliExecutor` — wraps `joplin` CLI via `execFile`; whitelist of subcommands; shell metacharacter blocking |
| `src/sync-manager.ts` | `SyncManager` — serialized sync queue (`triggerSync`), periodic timer, status: idle/syncing/error; **NOT used in the combined container** |
| `src/mcp/entry.ts` | MCP server entrypoint: parseConfig → createLogger → `JoplinDataClient(joplinCoreUrl, token)` → ping → `new ToolRegistry()` → `startMCPHttpServer()` |
| `src/mcp/server.ts` | MCP server factory: `createMCPServer()` registers tools, `startMCPServer()` (stdio), `startMCPHttpServer()` (HTTP + `/health` endpoint) |
| `src/mcp/tool-registry.ts` | `ToolRegistry` — static `TOOLS` record of 17 `RegisteredTool`; `executeTool(name,input,ctx)` does Zod parse → handler |
| `src/mcp/tools.ts` | 17 `ToolHandler` functions; write tools call `ctx.syncManager?.triggerSync()` (no-op when omitted); `ToolContext = { client, syncManager?, logger }` |
| `src/mcp/schemas.ts` | 17 Zod schemas; `joplinId = /^[0-9a-f]{32}$/`; `booleanNum = z.union([boolean, number→bool])`; `extractSchemaShape()` helper |

## 17 MCP Tools

### Read (7)
| Tool | Input | Output | Handler |
|------|-------|--------|---------|
| `list_notebooks` | `{}` | `Folder[]` | `client.getAllFolders()` |
| `list_notes` | `{limit?(1-100), page?(≥1)}` | `{items:Note[], has_more}` | `client.listNotes(limit,page,fields)` |
| `search_notes` | `{query(1-1000), type?}` | `SearchResult[]` | `client.search({query,type})` |
| `read_note` | `{note_id}` | `Note` | `client.getNote(id)` |
| `read_notebook` | `{notebook_id}` | `Folder` | `client.getFolder(id)` |
| `read_multinote` | `{note_ids[]}` | `{notes:Note[], errors[]}` | `Promise.allSettled` |
| `read_tags` | `{note_id}` | `Tag[]` | `client.getNoteTags(id)` |

### Write (8, all trigger sync if syncManager present)
| Tool | Input | Output |
|------|-------|--------|
| `create_note` | `{title,parent_id?,body?,author?,source_url?,is_todo?,todo_due?}` | `Note` |
| `create_folder` | `{title,parent_id?,icon?}` | `Folder` |
| `edit_note` | `{note_id, title?,parent_id?,body?,...}` | `Note` |
| `edit_folder` | `{folder_id, title?,parent_id?,icon?}` | `Folder` |
| `create_tag` | `{title(1-200)}` | `Tag` |
| `tag_note` | `{note_id, tag_id}` | `NoteTag` |
| `untag_note` | `{note_id, tag_id}` | `{success:true}` |

### Delete (2)
| Tool | Input | Output |
|------|-------|--------|
| `delete_note` | `{note_id}` | `{success:true}` |
| `delete_folder` | `{folder_id}` | `{success:true}` |

### Sync (1)
| Tool | Input | Output |
|------|-------|--------|
| `sync` | `{}` | `{status, lastSyncTime}` — returns static status when no SyncManager (combined container); triggers sync via SyncManager otherwise |

## Dependencies
```json
{
  "dependencies": {
    "@hono/node-server": "^1.19.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "hono": "^4.12.0",
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "@vitest/coverage-v8": "^2.1.9",
    "typescript": "^5.7.0",
    "eslint": "^9.0.0",
    "prettier": "^3.4.0",
    "tsx": "^4.0.0"
  }
}
```

## DataClient Method Map (26 methods)
```
ping() → PingResponse
listNotes/getAllNotes/getNote/createNote/updateNote/deleteNote
listFolders/getAllFolders/getFolder/createFolder/updateFolder/deleteFolder
listTags/getAllTags/getTag/createTag/deleteTag
getNoteTags/tagNote/untagNote
listResources/getAllResources/getResource
listEvents
search(SearchQuery) → SearchResult[]
```

## Key Patterns & Decisions
1. **Single combined container (production)**: Data API + MCP server + sync scheduler in one container; loopback-only communication
2. **Data API over CLI**: structured HTTP with typed responses, not CLI output parsing
3. **Write-through sync**: write tools trigger `syncManager.triggerSync()` (serialized, prevents SQLITE_BUSY)
4. **Remote-wins conflict resolution**: delegated to Joplin CLI
5. **Token lifecycle**: `POST /auth` → Bearer token, 55min expiry, 60s proactive refresh, re-auth on 401
6. **GuardedString**: private `#value` field, all coercions → `'[REDACTED]'`
7. **Stateless HTTP transport**: `sessionIdGenerator: undefined` → no session state between requests
8. **Bash sync scheduler** replaces TypeScript SyncManager for periodic sync; runs in its own process group via `setsid`
9. **ID validation**: `/^[a-zA-Z0-9_-]+$/` on all user-supplied IDs before HTTP calls
10. **Concurrency limiter**: max 5 concurrent Data API requests, queue overflow

## Docker Files
| File | Purpose |
|------|---------|
| `Dockerfile.combined` | Production: combined Joplin CLI + Data API + MCP HTTP server (node:22-bookworm-slim, multi-stage) |
| `Dockerfile.tests` | Test runner: vitest with v8 coverage, JUnit XML to `./reports/` |
| `docker-compose.yml` | Single service: `joplin-mcp` (combined container); test runner; volume: `joplin_data` |
| `docker-compose.test.yml` | Integration-test stack: two-container topology (retained for `make test-integration`) |
| `Dockerfile.core` | Test-stack only: Container A (Joplin CLI + Data API + socat) |
| `Dockerfile.mcp` | Test-stack only: Container B (stateless MCP HTTP server) |
| `entrypoint-combined.sh` | Production entrypoint: Data API + sync loop + MCP server with SIGTERM cleanup |
| `entrypoint-core.sh` | Test-stack only: Container A entrypoint |
| `entrypoint-mcp.sh` | Test-stack only: Container B entrypoint |

## Config Env Vars
| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `JOPLIN_SERVER_URL` | Yes | — | Joplin Server URL |
| `JOPLIN_USERNAME` | Yes | — | Joplin Server username/email |
| `JOPLIN_PASSWORD` | Yes | — | Joplin Server password |
| `JOPLIN_API_TOKEN` | No | — | Optional override; auto-extracted from CLI config when unset |
| `JOPLIN_DATA_API_PORT` | No | 41184 | Internal Data API port (loopback-only, rarely changed) |
| `MCP_HOST_PORT` | No | 3000 | Host-side MCP port (container always listens on internal 3000) |
| `LOG_LEVEL` | No | info | `debug`, `info`, `warn`, `error`, `silent` |
| `SYNC_INTERVAL_SECONDS` | No | 300 | Periodic sync interval in seconds |
| `NODE_ENV` | No | — | Set to `production` to enforce HTTPS for `JOPLIN_SERVER_URL` |

> **Note:** `JOPLIN_CORE_URL` is no longer operator-facing — the entrypoint sets it internally. `MCP_PORT` is canonicalized to 3000 by the entrypoint with a warning if set; use `MCP_HOST_PORT` for host-side mapping.

## Testing
- **Framework**: Vitest 2.x with v8 coverage (thresholds: 70% stmts, 60% branches, 70% funcs, 70% lines)
- **Tests**: `tests/*.test.ts` + `tests/mcp/*.test.ts` — mirrors src structure 1:1
- **Integration**: `tests/integration.test.ts` — skipped when Data API unavailable
- **Docker tests**: `Dockerfile.tests` runs vitest in container, mounts `./reports` for JUnit XML
