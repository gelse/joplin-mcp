# Project: Joplin API MCP Server

Model Context Protocol server enabling AI assistants to interact with Joplin note-taking software via 16 MCP tools over stdio transport. Packaged as a Docker container. Communicates with the Joplin Data API (HTTP, localhost) for all CRUD operations and delegates sync to the Joplin CLI subprocess against Joplin Server (sync target 10).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Client (e.g., Claude Desktop, or any MCP client)            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  MCP Client                            stdio transport    │  │
│  └──────────────┬────────────────────────────────────────────┘  │
└─────────────────┼────────────────────────────────────────────────┘
                  │ JSON-RPC over stdin/stdout
                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  Joplin API MCP Server (Node.js 22, TypeScript)                 │
│                                                                  │
│  ┌──────────────┐   ┌──────────────────┐   ┌────────────────┐   │
│  │  MCP Server  │──▶│  ToolRegistry    │──▶│  Tools (16)    │   │
│  │  (stdio)     │   │  (dispatch)      │   │  (handlers)    │   │
│  └──────────────┘   └────────┬─────────┘   └───────┬────────┘   │
│                              │                     │            │
│                              ▼                     ▼            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  JoplinDataClient (HTTP, token auth, localhost:${port}) │   │
│  │  - 21 methods: CRUD for notes, folders, tags, search     │   │
│  │  - Token lifecycle: POST /auth → reuse (5-min refresh)  │   │
│  │  - Re-fetch token on 401, retry once                     │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │ HTTP fetch()                      │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Joplin Data API (child process, localhost:${port})      │   │
│  │  - Spawned via: joplin server start --port ${port}       │   │
│  │  - Readiness: poll /ping endpoint (30 attempts, 1s)      │   │
│  │  - Access: local SQLite DB                               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  SyncManager (serialized queue)                          │   │
│  │  - initialSync(): full sync on startup                   │   │
│  │  - startPeriodicSync(): every SYNC_INTERVAL_SECONDS      │   │
│  │  - enqueueSync(): fire-and-forget after writes           │   │
│  │  - stopPeriodicSync(): on SIGTERM/SIGINT                 │   │
│  │  - Serialized: prevents SQLITE_BUSY from concurrent sync │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │ joplin sync (subprocess)          │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Joplin CLI (subprocess)                                 │   │
│  │  - sync.target = 10 (Joplin Server)                      │   │
│  │  - Configured via entrypoint.sh: joplin config sync.*    │   │
│  │  - Conflict behavior: remote-wins                        │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │ HTTPS                              │
└─────────────────────────────┼────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  Joplin Server (external)     │
              │  (your-instance.example.com)  │
              └───────────────────────────────┘
```

**Key flow**: AI Client ↔ JSON-RPC (stdio) ↔ MCP Server ↔ JoplinDataClient ↔ HTTP ↔ Data API ↔ SQLite. Writes enqueue sync: SyncManager ↔ CLI ↔ Joplin Server.

## Tech Stack

| Technology                | Version               | Purpose                                  |
| ------------------------- | --------------------- | ---------------------------------------- |
| Node.js                   | 22 LTS (>=22.0.0)     | Runtime                                  |
| TypeScript                | ^5.7.0                | Language (ESM)                           |
| pnpm                      | 9.x+                  | Package manager                          |
| @modelcontextprotocol/sdk | ^1.0.0                | MCP stdio transport, protocol types      |
| zod                       | ^3.23.0               | Schema validation (config + tool inputs) |
| pino                      | ^9.0.0                | Structured logging                       |
| pino-pretty               | ^11.0.0               | Pretty-print logs in dev                 |
| vitest                    | ^2.0.0                | Test framework                           |
| eslint                    | ^9.0.0                | Linting                                  |
| prettier                  | ^3.4.0                | Formatting                               |
| tsx                       | ^4.0.0                | Dev TypeScript runner (watch mode)       |
| Docker base               | node:22-bookworm-slim | Container image                          |

## Implementation Status

**ALL 5 phases complete.** 289/289 tests passing. Docker image: `joplin-api-mcp:latest` at 265 MB.

| Phase | Description                                                    | Status      |
| ----- | -------------------------------------------------------------- | ----------- |
| 1     | Foundation: config, errors, logger, types                      | ✅ Complete |
| 2     | Data API client: HTTP client, pagination, search               | ✅ Complete |
| 3     | MCP server: stdio transport, schemas, tool registry, handlers  | ✅ Complete |
| 4     | Sync: CLI executor, sync manager, write-triggered sync         | ✅ Complete |
| 5     | Docker: multi-stage build, entrypoint, healthcheck, smoke test | ✅ Complete |

## File Structure & Module Map

```
/workspace/
├── src/
│   ├── api-types.ts          # TypeScript interfaces: Note, Folder, Tag, Resource, etc.
│   ├── cli-executor.ts       # Joplin CLI subprocess: spawn + Promise wrapper, timeout
│   ├── config.ts             # Zod schema for env vars → typed Config object
│   ├── data-client.ts        # JoplinDataClient class (21 methods): CRUD + search + auth
│   ├── errors.ts             # Error hierarchy: ConfigError, CliError, DataApiError, SyncError
│   ├── logger.ts             # createLogger(): Pino instance with level from config
│   ├── pagination.ts         # clampLimit(), buildPageParam(), fetchAllPages()
│   ├── server.ts             # main(): entrypoint — Data API spawn, readiness, sync, MCP, signals
│   ├── sync-manager.ts       # SyncManager: serialized queue, periodic sync, initial sync
│   └── mcp/
│       ├── schemas.ts        # Zod schemas for all 16 tool inputs
│       ├── server.ts         # startMCPServer(): stdio transport setup, request handler
│       ├── tool-registry.ts  # ToolRegistry: register, dispatch, get all tools
│       └── tools.ts          # 16 handler functions: listNotebooks, createNote, sync, etc.
├── tests/
│   ├── cli-executor.test.ts
│   ├── config.test.ts
│   ├── data-client.test.ts
│   ├── errors.test.ts
│   ├── logger.test.ts
│   ├── pagination.test.ts
│   ├── server.test.ts
│   ├── sync-manager.test.ts
│   └── mcp/
│       ├── schemas.test.ts
│       ├── server.test.ts
│       ├── tool-registry.test.ts
│       └── tools.test.ts
├── scripts/
│   └── smoke-test.sh         # End-to-end test: container health, /ping, then cleanup
├── Dockerfile                # Multi-stage build: builder (full) → runtime (slim)
├── docker-compose.yml        # Service definition for local dev
├── entrypoint.sh             # Validate env, configure CLI sync, exec node server
├── .env.example              # Template for required env vars
├── tsconfig.json             # TypeScript config for IDE support
├── tsconfig.build.json       # TypeScript config for production build
├── vitest.config.ts          # Vitest configuration
├── eslint.config.mjs         # ESLint flat config (9.x)
├── .prettierrc               # Prettier formatting options
└── package.json              # Dependencies, scripts, engines (node >=22)
```

## MCP Tools

Grouped by category. Write tools (9) trigger fire-and-forget sync after completion.

### Read Tools (6)

| Tool             | Input              | Output           | Description                             |
| ---------------- | ------------------ | ---------------- | --------------------------------------- |
| `list_notebooks` | —                  | `Folder[]`       | List all notebooks/folders              |
| `search_notes`   | `{ query, type? }` | `SearchResult[]` | Search notes, folders, tags by query    |
| `read_note`      | `{ note_id }`      | `Note`           | Read single note with full body content |
| `read_notebook`  | `{ notebook_id }`  | `Folder`         | Read single notebook by ID              |
| `read_multinote` | `{ note_ids }`     | `(Note\|null)[]` | Read multiple notes (null for missing)  |
| `read_tags`      | `{ note_id }`      | `Tag[]`          | Get all tags for a note                 |

### Write Tools (9)

| Tool            | Input                               | Output   | Description                         |
| --------------- | ----------------------------------- | -------- | ----------------------------------- |
| `create_note`   | `{ title, body?, parent_id?, ... }` | `Note`   | Create note, triggers sync          |
| `create_folder` | `{ title }`                         | `Folder` | Create notebook, triggers sync      |
| `edit_note`     | `{ note_id, title?, body?, ... }`   | `Note`   | Update note, triggers sync          |
| `edit_folder`   | `{ folder_id, title }`              | `Folder` | Update folder, triggers sync        |
| `create_tag`    | `{ title }`                         | `Tag`    | Create tag, triggers sync           |
| `tag_note`      | `{ note_id, tag_id }`               | `void`   | Apply tag to note, triggers sync    |
| `untag_note`    | `{ note_id, tag_id }`               | `void`   | Remove tag from note, triggers sync |
| `delete_note`   | `{ note_id }`                       | `void`   | Delete note, triggers sync          |
| `delete_folder` | `{ folder_id }`                     | `void`   | Delete folder, triggers sync        |

### Sync Tool (1)

| Tool   | Input | Output | Description                                   |
| ------ | ----- | ------ | --------------------------------------------- |
| `sync` | —     | `void` | Manually trigger full sync with Joplin Server |

## Environment Variables

| Variable                | Required | Default | Purpose                                                   |
| ----------------------- | -------- | ------- | --------------------------------------------------------- |
| `JOPLIN_SERVER_URL`     | Yes      | —       | Joplin Server URL (e.g. `https://joplin.example.com/`)    |
| `JOPLIN_USERNAME`       | Yes      | —       | Joplin Server username/email                              |
| `JOPLIN_PASSWORD`       | Yes      | —       | Joplin Server password                                    |
| `JOPLIN_DATA_API_PORT`  | No       | `41100` | Data API listen port                                      |
| `LOG_LEVEL`             | No       | `info`  | Logging level: `debug`, `info`, `warn`, `error`, `silent` |
| `SYNC_INTERVAL_SECONDS` | No       | `300`   | Periodic sync interval                                    |

## Key Design Decisions

1. **Data API over CLI for data operations** — The Joplin Data API provides structured HTTP endpoints with JSON responses, avoiding fragile CLI output parsing. CLI is used only for sync (`joplin sync`), where it's unavoidable.

2. **No HTTP framework** — The MCP SDK (`@modelcontextprotocol/sdk`) provides the stdio transport layer. `fetch()` (native Node.js 22) handles Data API HTTP calls. No Express/Fastify/Koa dependency.

3. **Write-through sync** — Every write tool handler calls `syncManager.enqueueSync()` after the API operation. This ensures Joplin Server is updated promptly without blocking the MCP response.

4. **Serialized sync queue** — Sync operations are queued and executed one-at-a-time to prevent concurrent `joplin sync` processes from causing `SQLITE_BUSY` errors in the local database.

5. **Remote-wins conflict resolution** — When sync conflicts occur, remote (Joplin Server) changes take precedence. Conflicts are logged at WARN level for awareness.

6. **Token lifecycle** — The Data API requires a bearer token for authenticated requests. Token is obtained via `POST /auth` with credentials, reused with a 5-minute freshness check, and transparently re-fetched on 401 responses with one retry.

## Error Handling

```
Error
├── ConfigError                  # Missing/invalid env vars → exit immediately
├── CliError                     # Joplin CLI subprocess failure
│   └── Properties: result = { stdout: string, stderr: string, exitCode: number }
├── DataApiError                 # Joplin Data API HTTP error
│   ├── Properties: statusCode: number, responseBody?: string
│   ├── NotFoundError (404)      # Resource not found by ID
│   ├── ConflictError (409)      # Resource modified since fetch (ETag mismatch)
│   ├── ValidationError (400)    # Invalid request payload
│   └── AuthError (401)          # Token expired or invalid → triggers re-auth
└── SyncError                    # Sync operation failure
    └── Properties: cause?: Error
```

## Entrypoint Flow

1. **entrypoint.sh** validates required env vars (`JOPLIN_SERVER_URL`, `JOPLIN_USERNAME`, `JOPLIN_PASSWORD`)
2. **entrypoint.sh** configures Joplin CLI: `sync.target = 10`, server URL, credentials
3. **entrypoint.sh** `exec node dist/server.js` (replaces shell, signals flow through to Node)
4. **`parseConfig()`** validates all env vars via Zod schema, applies defaults
5. **`createLogger()`** initializes Pino structured logger at configured level
6. **`startDataApiServer()`** spawns `joplin server start` as child process
7. **Poll `/ping`** every 1s (max 30 attempts) until Data API responds ok
8. **`new JoplinDataClient()`** connects to Data API, pings for version/status
9. **`syncManager.initialSync()`** runs full sync via CLI before accepting requests
10. **`syncManager.startPeriodicSync()`** begins interval-based sync loop
11. **`ToolRegistry`** initializes with all 16 tool handlers
12. **`startMCPServer()`** blocks on MCP stdio transport, processes JSON-RPC messages
13. **`SIGTERM`/`SIGINT`** → stop periodic sync → kill Data API (SIGTERM, 2s grace, SIGKILL) → exit

## Testing

- **Framework**: Vitest v2 (ESM-native, TypeScript first-class)
- **Test files**: 12
- **Total tests**: 289
- **Coverage**: Unit tests for pure-logic modules (config parsing, error classes, pagination utilities). Data client, sync manager, and MCP tools require a live Joplin Data API and are tested via the smoke test.
- **Smoke test**: `./scripts/smoke-test.sh` — builds Docker image, starts container, waits for health check (`/ping`), performs readiness verification, cleans up.

## Common Commands

```bash
pnpm install                    # Install all dependencies (frozen lockfile for CI)
pnpm build                      # Compile TypeScript via tsc (tsconfig.build.json)
pnpm dev                        # Dev mode: tsx watch src/server.ts (hot reload)
pnpm start                      # Run compiled server: node dist/server.js
pnpm test                       # Run all tests via vitest
pnpm test:watch                 # Run tests in watch mode
pnpm lint                       # ESLint on src/ — .ts files
pnpm format                     # Prettier — write src/**/*.ts
```

## Build & Deployment

### Docker

```bash
# Build image
docker compose build

# Run container (detached)
docker compose up -d

# View logs
docker compose logs -f

# Stop and remove
docker compose down

# Run without compose
docker run -i --rm \
  --env-file .env \
  -e JOPLIN_DATA_API_PORT=41100 \
  joplin-api-mcp:latest
```

### MCP Client Configuration

```json
{
  "mcpServers": {
    "joplin": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--env-file", "/path/to/.env", "joplin-api-mcp"]
    }
  }
}
```

### Dockerfile Details

- **Builder stage**: `node:22-bookworm-slim` → install pnpm → frozen lockfile → TypeScript compile
- **Runtime stage**: `node:22-bookworm-slim` → system deps (libsecret-1-0, ca-certificates, curl) → global joplin CLI → production dependencies → non-root `joplin` user
- **Healthcheck**: `curl -f http://localhost:${JOPLIN_DATA_API_PORT:-41100}/ping` (30s interval, 60s start period)
- **Image size**: ~265 MB

## Development Guidelines

### Code Style & Conventions

- **Language**: TypeScript 5.7+ with strict ESM (`"type": "module"`)
- **Imports**: Always include `.js` extension for ESM compatibility (`import { X } from "./foo.js"`)
- **Error handling**: Use typed error hierarchy; log structured errors with Pino (`logger.error({ err }, "message")`)
- **Async**: Use `async/await` consistently; top-level `main().catch()` for fatal errors
- **Testing**: Pure-logic modules get unit tests; integration tested via smoke test
- **Config**: All configuration via environment variables validated through Zod schema
- **Logging**: Structured JSON logging with Pino; use appropriate levels (debug/info/warn/error)
- **Signals**: Handle SIGTERM and SIGINT for graceful shutdown
