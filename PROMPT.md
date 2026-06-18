# PROMPT.md — Joplin API MCP Server (AI-Optimized Context)

## Identity
- **Name**: `joplin-api-mcp` (npm: `joplin-api-mcp`)
- **Purpose**: MCP server exposing Joplin note-taking (notes, folders, tags, search, sync) to AI assistants via 17 tools over StreamableHTTP transport.
- **License**: MIT
- **Node**: `>=22.0.0`, ESM (`"type": "module"`)
- **Lang**: TypeScript 5.7, compiled via `tsc -p tsconfig.build.json`
- **Entry**: `src/mcp/entry.ts` → `dist/mcp/entry.js`

## Architecture: Two-Container (Docker) / Single-Process (Native)

### Container A: `joplin-core` (stateful)
- Runs Joplin CLI + Data API server on port 41184
- `entrypoint-core.sh`: bash sync scheduler (`while true; do joplin sync; sleep N; done`)
- Persistent SQLite DB at `/home/joplin/.config/joplin` (Docker volume: `joplin_data`)
- Syncs against `JOPLIN_SERVER_URL` with `JOPLIN_USERNAME`/`JOPLIN_PASSWORD`
- Healthcheck: `curl http://localhost:41184/ping`

### Container B: `joplin-mcp` (stateless)
- Node.js MCP HTTP server on port 3000 (StreamableHTTPServerTransport, sessionless: `sessionIdGenerator: undefined`)
- Proxies ALL data operations to Container A via `JoplinDataClient` → `JOPLIN_CORE_URL`
- NO SyncManager, NO Joplin CLI, NO filesystem access
- Graceful shutdown on SIGTERM/SIGINT (5s force timeout)
- Entry: `entrypoint-mcp.sh` → `node dist/mcp/entry.js`

## Source File Map

| File | Role |
|------|------|
| `src/config.ts` | Zod env parser: `JOPLIN_SERVER_URL`, `JOPLIN_USERNAME`, `JOPLIN_PASSWORD`, `JOPLIN_API_TOKEN`, `JOPLIN_CORE_URL`, `JOPLIN_DATA_API_PORT`(41184), `LOG_LEVEL`(info), `SYNC_INTERVAL_SECONDS`(300) |
| `src/logger.ts` | Pino structured logger (`pino` + `pino-pretty`), `createLogger(config)` |
| `src/guarded-string.ts` | `GuardedString` class — `#value` private field, `toString()`/`toJSON()` return `'[REDACTED]'`, only `.value` exposes raw |
| `src/errors.ts` | Hierarchy: `ConfigError`, `DataApiError(statusCode,responseBody?)`, `NotFoundError(404)`, `ConflictError(409)`, `ValidationError(400)`, `AuthError(401)`, `FatalError(cause?,exitCode)` |
| `src/api-types.ts` | TS interfaces: `Note`, `Folder`, `Tag`, `Resource`, `NoteTag`, `Event`, `SearchResult`, `PingResponse`, `PaginatedResponse<T>`, payload types for CRUD |
| `src/pagination.ts` | `clampLimit(n)` → 1–100, `buildPageParam(p)` → `&page=N`, `fetchAllPages(fn)` → loop `has_more` |
| `src/data-client.ts` | `JoplinDataClient` — HTTP client for Joplin Data API; 26 methods; auth via `POST /auth` (Bearer token, 55min expiry, 60s proactive refresh, 401 retry); concurrency limiter (max 5); ID validation (`/^[a-zA-Z0-9_-]+$/`) |
| `src/cli-executor.ts` | `CliExecutor` — wraps `joplin` CLI via `execFile`; whitelist of subcommands; shell metacharacter blocking |
| `src/sync-manager.ts` | `SyncManager` — serialized sync queue (`triggerSync`), periodic timer, status: idle/syncing/error; **NOT used in Container B** |
| `src/mcp/entry.ts` | Container B entrypoint: parseConfig → createLogger → `JoplinDataClient(joplinCoreUrl, token)` → ping → `new ToolRegistry()` → `startMCPHttpServer()` |
| `src/mcp/server.ts` | MCP server factory: `createMCPServer()` registers tools, `startMCPServer()` (stdio), `startMCPHttpServer()` (HTTP + `/health` endpoint) |
| `src/mcp/tool-registry.ts` | `ToolRegistry` — static `TOOLS` record of 17 `RegisteredTool`; `executeTool(name,input,ctx)` does Zod parse → handler |
| `src/mcp/tools.ts` | 17 `ToolHandler` functions; write tools call `ctx.syncManager?.triggerSync()` (no-op in Container B); `ToolContext = { client, syncManager?, logger }` |
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
| `sync` | `{}` | `{status, lastSyncTime}` — with syncManager: triggers sync; without: returns "managed by core container" |

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
1. **Two-container separation**: stateful sync backend vs stateless MCP frontend
2. **Data API over CLI**: structured HTTP with typed responses, not CLI output parsing
3. **Write-through sync**: write tools trigger `syncManager.triggerSync()` (serialized, prevents SQLITE_BUSY)
4. **Remote-wins conflict resolution**: delegated to Joplin CLI
5. **Token lifecycle**: `POST /auth` → Bearer token, 55min expiry, 60s proactive refresh, re-auth on 401
6. **GuardedString**: private `#value` field, all coercions → `'[REDACTED]'`
7. **Stateless HTTP transport**: `sessionIdGenerator: undefined` → no session state between requests
8. **Bash sync scheduler** in Container A replaces TypeScript SyncManager for periodic sync
9. **ID validation**: `/^[a-zA-Z0-9_-]+$/` on all user-supplied IDs before HTTP calls
10. **Concurrency limiter**: max 5 concurrent Data API requests, queue overflow

## Docker Files
| File | Purpose |
|------|---------|
| `Dockerfile.core` | Container A: node:22-bookworm-slim, Joplin CLI, socat, bash entrypoint |
| `Dockerfile.mcp` | Container B: multi-stage build, `mcp` user, dist-only prod stage |
| `Dockerfile.tests` | Test runner: vitest with v8 coverage, JUnit XML to `./reports/` |
| `docker-compose.yml` | 3 services: joplin-core, joplin-mcp, test; volume: `joplin_data` |

## Config Env Vars
| Var | Required | Default | Used By |
|-----|----------|---------|---------|
| `JOPLIN_SERVER_URL` | Core only | — | Container A |
| `JOPLIN_USERNAME` | Core only | — | Container A |
| `JOPLIN_PASSWORD` | Core only | — | Container A |
| `JOPLIN_API_TOKEN` | Both | — | Both |
| `JOPLIN_CORE_URL` | MCP only | — | Container B |
| `JOPLIN_DATA_API_PORT` | No | 41184 | Container A |
| `MCP_PORT` | No | 3000 | Container B |
| `LOG_LEVEL` | No | info | Both |
| `SYNC_INTERVAL_SECONDS` | No | 300 | Container A |
| `NODE_ENV` | No | — | Enforces HTTPS for JOPLIN_SERVER_URL in production |

## Testing
- **Framework**: Vitest 2.x with v8 coverage (thresholds: 70% stmts, 60% branches, 70% funcs, 70% lines)
- **Tests**: `tests/*.test.ts` + `tests/mcp/*.test.ts` — mirrors src structure 1:1
- **Integration**: `tests/integration.test.ts` — skipped when Data API unavailable
- **Docker tests**: `Dockerfile.tests` runs vitest in container, mounts `./reports` for JUnit XML
