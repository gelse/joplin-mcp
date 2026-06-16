# Joplin API MCP Server

MCP (Model Context Protocol) server for [Joplin](https://joplinapp.org/), synced via [Joplin Server](https://github.com/laurent22/joplin/blob/dev/packages/server/README.md). Enables AI assistants to read, search, create, edit, tag, delete, and sync Joplin notes through the standard MCP interface.

## Architecture

```mermaid
graph TD
    A[AI Client] -->|MCP stdio| B[TypeScript MCP Server]
    B -->|HTTP fetch()| C[JoplinDataClient]
    C -->|Token Auth| D[Joplin Data API]
    D -->|Child Process| E[Joplin SQLite DB]
    B -->|SyncManager| F[Joplin CLI sync]
    F -->|sync.target 10| G[Joplin Server]
    G -->|HTTPS| F
    B -->|SIGTERM cleanup| D
```

**Layered architecture:**

1. **MCP Client** connects via **stdio** transport to the TypeScript MCP server
2. **MCP Server** exposes 16 tools and delegates data operations to **JoplinDataClient**
3. **JoplinDataClient** communicates with the **Joplin Data API** (HTTP, token auth, localhost)
4. **Joplin Data API** runs as a child process spawned by the server, reading/writing the local **SQLite database**
5. **SyncManager** orchestrates sync via the **Joplin CLI** (subprocess) against **Joplin Server** (sync target 10)
6. Write operations trigger fire-and-forget sync; periodic sync runs every 5 minutes

## Quick Start

### Prerequisites

- Docker and Docker Compose
- A running [Joplin Server](https://github.com/laurent22/joplin/blob/dev/packages/server/README.md) instance
- Joplin Server credentials (email + password)

### Setup

1. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your Joplin Server credentials:

   ```env
   JOPLIN_SERVER_URL=https://joplin.example.com/
   JOPLIN_USERNAME=your-email@example.com
   JOPLIN_PASSWORD=your-password
   ```

3. Start the container:

   ```bash
   docker compose up -d
   ```

4. Check logs:
   ```bash
   docker compose logs -f
   ```

### MCP Client Configuration

Add to your MCP client configuration (e.g., Claude Desktop):

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

## Environment Variables

| Variable                | Required | Default | Description                                             |
| ----------------------- | -------- | ------- | ------------------------------------------------------- |
| `JOPLIN_SERVER_URL`     | **Yes**  | —       | Joplin Server URL (e.g., `https://joplin.example.com/`) |
| `JOPLIN_USERNAME`       | **Yes**  | —       | Joplin Server username/email                            |
| `JOPLIN_PASSWORD`       | **Yes**  | —       | Joplin Server password                                  |
| `JOPLIN_DATA_API_PORT`  | No       | `41100` | Internal Data API listen port                           |
| `LOG_LEVEL`             | No       | `info`  | Log level: `debug`, `info`, `warn`, `error`, `silent`   |
| `SYNC_INTERVAL_SECONDS` | No       | `300`   | Periodic sync interval in seconds                       |

## Sync Behavior

- **Initial sync**: Runs on startup via SyncManager before accepting MCP requests
- **Periodic sync**: Every 5 minutes (configurable via `SYNC_INTERVAL_SECONDS`)
- **Write-triggered sync**: After every create/update/delete/untag operation (fire-and-forget via serialized queue)
- **Conflict resolution**: Remote always wins (merge conflicts logged at WARN level)
- **Serialized queue**: Prevents `SQLITE_BUSY` errors by serializing sync operations

## Key Design Decisions

1. **Data API over CLI for data operations** — Avoids fragile CLI output parsing; uses structured HTTP API with typed responses
2. **No HTTP framework** — MCP SDK provides stdio transport; `fetch()` (built-in Node.js) handles Data API calls
3. **Write-through sync** — Write tools trigger immediate sync so Joplin Server is always up-to-date
4. **Serialized sync queue** — Prevents concurrent sync calls causing `SQLITE_BUSY` errors
5. **Remote-wins conflict resolution** — Simplifies conflict handling; local changes always yield to remote
6. **Token lifecycle** — Auth token obtained via `POST /auth`, reused with 5-minute freshness check, re-fetched on 401 responses

## Entrypoint Flow

1. **Validate environment variables** — Entrypoint script checks `JOPLIN_SERVER_URL`, `JOPLIN_USERNAME`, `JOPLIN_PASSWORD`
2. **Configure Joplin CLI** — Sets `sync.target 10` and server credentials in Joplin CLI config
3. **Start TypeScript server** — `exec node dist/server.js` (foreground)
4. **Parse config** — Zod schema validates all env vars with defaults
5. **Initialize logger** — Pino structured logger at configured level
6. **Start Joplin Data API** — Spawned as child process on configurable port (default: 41100)
7. **Wait for readiness** — Polls `/ping` endpoint (up to 30s, 1s intervals)
8. **Verify connectivity** — Pings Data API to confirm auth and version
9. **Perform initial sync** — SyncManager runs full sync via Joplin CLI
10. **Start periodic sync** — Interval-based sync loop begins
11. **Initialize tool registry** — Registers all 16 MCP tool handlers
12. **Start MCP server** — Blocks on stdio transport, serving MCP requests
13. **Handle signals** — On `SIGTERM`/`SIGINT`: stop periodic sync, kill Data API process (SIGTERM → 2s grace → SIGKILL), exit

## Error Handling

```
Error
├── ConfigError              # Missing/invalid environment variables
├── CliError                 # Joplin CLI subprocess failure
│   └── Properties: result { stdout, stderr, exitCode }
├── DataApiError             # Joplin Data API HTTP error
│   ├── statusCode: number
│   ├── responseBody?: string
│   ├── NotFoundError (404)  # Resource not found
│   ├── ConflictError (409)  # Resource modified since fetch
│   ├── ValidationError (400)# Invalid input
│   └── AuthError (401)      # Authentication failed
└── FatalError               # Fatal/unexpected error
    ├── cause?: unknown
    └── exitCode: number (default 1)
```

## Available MCP Tools

| Tool             | Description                     | Writes? |
| ---------------- | ------------------------------- | ------- |
| `list_notebooks` | List all notebooks/folders      | No      |
| `search_notes`   | Search notes, folders, and tags | No      |
| `read_note`      | Read a single note by ID        | No      |
| `read_notebook`  | Read a single notebook by ID    | No      |
| `read_multinote` | Read multiple notes by IDs      | No      |
| `read_tags`      | Get tags for a note             | No      |
| `create_note`    | Create a new note               | **Yes** |
| `create_folder`  | Create a new notebook           | **Yes** |
| `edit_note`      | Edit an existing note           | **Yes** |
| `edit_folder`    | Edit an existing folder         | **Yes** |
| `create_tag`     | Create a new tag                | **Yes** |
| `tag_note`       | Apply a tag to a note           | **Yes** |
| `untag_note`     | Remove a tag from a note        | **Yes** |
| `delete_note`    | Delete a note                   | **Yes** |
| `delete_folder`  | Delete a folder                 | **Yes** |
| `sync`           | Manually trigger sync           | No      |

## Development

### Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Run in development mode with hot reload (tsx watch)
pnpm build            # Compile TypeScript (tsc)
pnpm start            # Run compiled server (node dist/server.js)
pnpm test             # Run tests (vitest)
pnpm test:watch       # Run tests in watch mode
pnpm lint             # Lint source code (eslint)
pnpm format           # Format source code (prettier --write)
```

## Project Structure

```
src/
├── server.ts              # Main entry point: orchestrates startup & lifecycle
├── config.ts              # Zod-based environment config parsing
├── logger.ts              # Pino structured logger
├── cli-executor.ts        # Joplin CLI subprocess wrapper
├── sync-manager.ts        # Serialized sync queue orchestrator
├── data-client.ts         # Joplin Data API HTTP client (21 methods, token auth)
├── api-types.ts           # TypeScript type definitions for Joplin API
├── errors.ts              # Typed error class hierarchy
├── pagination.ts          # Pagination helpers (clampLimit, fetchAllPages)
└── mcp/
    ├── server.ts          # MCP stdio server setup
    ├── schemas.ts         # Zod validation schemas for all 16 tools
    ├── tools.ts           # 16 tool handler implementations
    └── tool-registry.ts   # Tool registration and dispatch
tests/
├── cli-executor.test.ts   # CLI executor tests
├── config.test.ts         # Config parser tests
├── data-client.test.ts    # Data API client tests
├── errors.test.ts         # Error class hierarchy tests
├── logger.test.ts         # Logger tests
├── pagination.test.ts     # Pagination helper tests
├── server.test.ts         # Server tests
└── sync-manager.test.ts   # Sync manager tests
scripts/
└── smoke-test.sh          # End-to-end Docker container smoke test
```

## License

MIT
