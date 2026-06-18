# Joplin API MCP Server

An MCP (Model Context Protocol) server that exposes Joplin's note-taking functionality — notes, folders, tags, search, and sync — to AI assistants via 17 tools.

## tl;dr / Quick Start

### Docker (recommended)

The recommended deployment uses two containers — a stateful sync backend ([`joplin-core`](#architecture)) and a stateless MCP HTTP server ([`joplin-mcp`](#architecture)) — orchestrated via [`docker-compose.yml`](docker-compose.yml):

```bash
cp .env.example .env   # fill in required variables
docker compose up -d   # starts both containers with healthchecks
```

Add this to your MCP client config:

```json
{
  "mcpServers": {
    "joplin": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

> `joplin-mcp` exposes an HTTP endpoint on port 3000 (not stdio). See [MCP Client Configuration](#mcp-client-configuration) for other setups.

### Native Installation

For local development or without Docker, the MCP HTTP server ([`src/mcp/entry.ts`](src/mcp/entry.ts)) connects to a running Joplin Data API:

```bash
git clone <repo-url> && cd joplin-api
cp .env.example .env   # fill in JOPLIN_API_TOKEN and JOPLIN_CORE_URL
pnpm install
pnpm build && pnpm start
```

MCP client config (HTTP):

```json
{
  "mcpServers": {
    "joplin": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

---

## Detailed How-To

### Direct Installation

#### Prerequisites

- **Node.js** 20 or later (the project's [`package.json`](package.json) `engines` field requires `>=22.0.0`)
- **[pnpm](https://pnpm.io/)** 9 or later (for package management)
- **Joplin desktop app** running with the **Data API (ClipperServer)** enabled:
  - In Joplin: *Web Clipper → Options → Enable Clipper Server*
  - The server binds to `127.0.0.1:41184` by default and ignores `--host`/`--port` flags
- **Joplin Server** (optional but recommended) — a sync target for multi-device synchronisation. Without it, write-through sync will fail and notes remain local-only

#### Installation

```bash
git clone <repo-url>
cd joplin-api
pnpm install
pnpm build
```

#### Configuration

Copy the environment template and fill in your values:

```bash
cp .env.example .env
```

All configuration is done via environment variables:

| Variable                | Required | Default | Description                                                  |
| ----------------------- | -------- | ------- | ------------------------------------------------------------ |
| `JOPLIN_SERVER_URL`     | **Yes**  | —       | Joplin Server URL (e.g., `https://joplin.example.com/`)      |
| `JOPLIN_USERNAME`       | **Yes**  | —       | Joplin Server username/email                                 |
| `JOPLIN_PASSWORD`       | **Yes**  | —       | Joplin Server password                                       |
| `JOPLIN_DATA_API_PORT`  | No       | `41184` | Internal Data API listen port (Joplin ClipperServer hardcoded default) |
| `LOG_LEVEL`             | No       | `info`  | Log level: `debug`, `info`, `warn`, `error`, `silent`        |
| `SYNC_INTERVAL_SECONDS` | No       | `300`   | Periodic sync interval in seconds                            |
| `NODE_ENV`              | No       | —       | Set to `production` to enforce HTTPS for `JOPLIN_SERVER_URL` |

> **Note:** `JOPLIN_API_TOKEN` is not a user-facing variable. The [core entrypoint script](entrypoint-core.sh) automatically extracts it from Joplin's config (`joplin config api.token`) and exports it for the server. If running natively without the entrypoint, you must set `JOPLIN_API_TOKEN` manually (run `joplin config api.token` in your terminal to get it).

#### Running the Server

```bash
# Production (compiled)
pnpm build && pnpm start

# Development (hot reload via tsx watch)
pnpm dev
```

The MCP HTTP server connects to a running Joplin Data API (via `JOPLIN_CORE_URL`), validates connectivity, then begins serving MCP requests over HTTP on port 3000 (configurable via `MCP_PORT`).

#### MCP Client Configuration (Native / Node.js)

The MCP HTTP server exposes an **HTTP endpoint** (not stdio). Configure your MCP client to connect via URL:

```json
{
  "mcpServers": {
    "joplin": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

#### Testing

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Lint
pnpm lint

# Format
pnpm format
```

Tests use [Vitest](https://vitest.dev/) and cover all modules: config parsing, CLI executor, data client, error classes, sync manager, pagination, MCP schemas, tool handlers, and integration tests against a live Joplin Data API.

### Docker

#### Prerequisites

- **Docker** and **Docker Compose** installed on your system
- The [`.env.example`](.env.example) file copied to `.env` and configured with your Joplin Server credentials

The deployment uses two Dockerfiles ([`Dockerfile.core`](Dockerfile.core) and [`Dockerfile.mcp`](Dockerfile.mcp)) orchestrated via [`docker-compose.yml`](docker-compose.yml).

#### Building

```bash
# Build both containers
docker compose build

# Or build individually
docker compose build joplin-core
docker compose build joplin-mcp
```

#### Running

```bash
docker compose up -d   # starts joplin-core first, then joplin-mcp after healthcheck passes
```

#### Viewing Logs

```bash
docker compose logs -f               # both containers
docker compose logs -f joplin-core   # sync/Data API logs only
docker compose logs -f joplin-mcp    # MCP HTTP server logs only
```

#### Stopping

```bash
docker compose down
```

#### Environment Variables

Place variables in the `.env` file (automatically picked up by [`docker-compose.yml`](docker-compose.yml)).

| Variable                | Container       | Required | Default | Description                                                  |
| ----------------------- | --------------- | -------- | ------- | ------------------------------------------------------------ |
| `JOPLIN_SERVER_URL`     | joplin-core     | **Yes**  | —       | Joplin Server URL (e.g., `https://joplin.example.com/`)      |
| `JOPLIN_USERNAME`       | joplin-core     | **Yes**  | —       | Joplin Server username/email                                 |
| `JOPLIN_PASSWORD`       | joplin-core     | **Yes**  | —       | Joplin Server password                                       |
| `JOPLIN_API_TOKEN`      | both            | **Yes**  | —       | Joplin Data API token (extracted from `joplin config api.token`) |
| `JOPLIN_CORE_URL`       | joplin-mcp      | **Yes**  | —       | URL of the joplin-core Data API (e.g., `http://joplin-core:41184`) |
| `JOPLIN_DATA_API_PORT`  | joplin-core     | No       | `41184` | Internal Data API listen port                                |
| `MCP_PORT`              | joplin-mcp      | No       | `3000`  | MCP HTTP server port (exposed to host)                       |
| `LOG_LEVEL`             | both            | No       | `info`  | Log level: `debug`, `info`, `warn`, `error`, `silent`        |
| `SYNC_INTERVAL_SECONDS` | joplin-core     | No       | `300`   | Periodic sync interval in seconds                            |
| `NODE_ENV`              | joplin-core     | No       | —       | Set to `production` to enforce HTTPS for `JOPLIN_SERVER_URL` |

#### MCP Client Configuration (Docker)

The `joplin-mcp` container exposes an **HTTP endpoint** (not stdio). Configure your MCP client to connect via URL:

```json
{
  "mcpServers": {
    "joplin": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

#### How It Works

- **Two containers**: `joplin-core` (stateful, runs Joplin CLI + Data API + bash sync scheduler) and `joplin-mcp` (stateless, Node.js MCP HTTP server only)
- **Multi-stage builds**: [`Dockerfile.mcp`](Dockerfile.mcp) uses `node:22-bookworm-slim` with separate build and production stages; [`Dockerfile.core`](Dockerfile.core) is a single-stage Debian-based image
- **Non-root users**: `joplin` user in joplin-core, `mcp` user in joplin-mcp
- **Persistent volume**: `joplin_data` volume mounted at `/home/joplin/.config/joplin` stores the Joplin profile and SQLite database
- **Internal networking**: joplin-mcp communicates with joplin-core via the Docker internal network using the service name `joplin-core`
- **Healthchecks**: joplin-core healthchecks `/ping` on port 41184; joplin-mcp waits for joplin-core to be healthy before starting
- **Sync scheduler**: A bash `while true` loop in [`entrypoint-core.sh`](entrypoint-core.sh) handles periodic sync with extensive logging to `/var/log/joplin/`

#### Testing with Docker

A dedicated [`Dockerfile.tests`](Dockerfile.tests) and `test` service in [`docker-compose.yml`](docker-compose.yml) allow running the test suite in a container:

```bash
# Build the test image
docker build -f Dockerfile.tests -t joplin-api-tests .

# Run tests
docker run --rm joplin-api-tests

# Or via docker compose (requires --profile test since the test service uses profiles)
docker compose --profile test run --rm tests
```

Tests use [Vitest](https://vitest.dev/) with v8 coverage (thresholds: 70% statements, 60% branches, 70% functions, 70% lines) and output JUnit XML reports to `./reports/`. When running via docker compose, the `./reports` directory is mounted into the container so reports persist on the host.

The test suite does not require a running Joplin instance — unit tests use mocks, and integration tests are skipped when the Joplin Data API is unavailable.

---

## Architecture

### Two-Container Deployment (Docker)

```mermaid
graph TD
    A[AI Client] -->|"MCP HTTP (port 3000)"| B[Container B: joplin-mcp]
    B -->|"HTTP fetch() + Bearer Token"| C[Container A: joplin-core]
    subgraph "Container A: joplin-core"
        C[Joplin Data API :41184] -->|"read/write"| D[(Joplin SQLite DB)]
        E[Bash Sync Scheduler] -->|"joplin sync"| F[Joplin Server]
        F -->|"HTTPS"| E
    end
    subgraph "Container B: joplin-mcp"
        B -->|"Tool handlers"| G[JoplinDataClient]
    end
```

1. **AI Client** connects to **joplin-mcp** via HTTP on port 3000 (MCP StreamableHTTP transport)
2. **joplin-mcp** is a **stateless** Node.js server — no Joplin CLI, no sync logic, no local DB
3. **JoplinDataClient** in joplin-mcp issues HTTP requests to **joplin-core** on the internal Docker network
4. **joplin-core** runs the **Joplin Data API** internally on `127.0.0.1:41185`, with a **socat TCP proxy** exposing `0.0.0.0:41184` to the Docker network, backed by a persistent SQLite volume
5. **Bash sync scheduler** in joplin-core handles periodic sync via the Joplin CLI against Joplin Server
6. Write operations from the MCP server trigger sync via the Data API; bash scheduler provides periodic backup sync
7. Both containers use **healthchecks** — joplin-mcp waits for joplin-core to be healthy before starting

## Available MCP Tools

### Tool Overview

| Tool             | Description                                       | Writes? |
| ---------------- | ------------------------------------------------- | ------- |
| `list_notebooks` | List all notebooks/folders                        | No      |
| `list_notes`     | List notes with pagination and metadata fields    | No      |
| `search_notes`   | Search notes, folders, and tags                   | No      |
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

### Input / Output Schemas

All tool input is validated through [Zod](https://zod.dev/) schemas. Below are the expected input fields and return types.

#### Read Tools

| Tool             | Input                                                                  | Output                                            |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `list_notebooks` | `{}`                                                                   | `Folder[]`                                        |
| `list_notes`     | `{ limit?: number (1–100), page?: number (≥1) }`                       | `{ items: Note[], has_more: boolean }`            |
| `search_notes`   | `{ query: string (1–1000 chars), type?: "note" \| "folder" \| "tag" }` | `SearchResult[]`                                  |
| `read_note`      | `{ note_id: string (32-char hex) }`                                    | `Note`                                            |
| `read_notebook`  | `{ notebook_id: string (32-char hex) }`                                | `Folder`                                          |
| `read_multinote` | `{ note_ids: string[] (array of 32-char hex IDs) }`                    | `{ notes: Note[], errors: { note_id, error }[] }` |
| `read_tags`      | `{ note_id: string (32-char hex) }`                                    | `Tag[]`                                           |

#### Write Tools

| Tool            | Input                                                                                                                                                                                           | Output              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `create_note`   | `{ title (1–500 chars), parent_id?, body? (max 1 MB), author? (max 200), source_url? (validated URL), is_todo? (boolean \| number 0/1), todo_due? (unix ms) }`                                      | `Note`              |
| `create_folder` | `{ title (1–500 chars), parent_id?, icon? (max 100) }`                                                                                                                                         | `Folder`            |
| `edit_note`     | `{ note_id, title?, parent_id?, body?, author? (max 200), source_url? (validated URL), is_todo? (boolean \| number 0/1), todo_due? (unix ms) }`                                                     | `Note`              |
| `edit_folder`   | `{ folder_id, title?, parent_id?, icon? (max 100) }`                                                                                                                                           | `Folder`            |
| `create_tag`    | `{ title (1–200 chars) }`                                                                                                                                                                       | `Tag`               |
| `tag_note`      | `{ note_id, tag_id }`                                                                                                                                                                           | `NoteTag`           |
| `untag_note`    | `{ note_id, tag_id }`                                                                                                                                                                           | `{ success: true }` |

#### Delete Tools

| Tool            | Input           | Output              |
| --------------- | --------------- | ------------------- |
| `delete_note`   | `{ note_id }`   | `{ success: true }` |
| `delete_folder` | `{ folder_id }` | `{ success: true }` |

#### Sync Tool

| Tool   | Input | Output                                                     |
| ------ | ----- | ---------------------------------------------------------- |
| `sync` | `{}`  | `{ status: "idle" \| "syncing", lastSyncTime: string \| null }` |

### Error Response Format

When a tool execution fails, the MCP server returns a response with `isError: true` and a `content` array containing a single text entry:

```json
{
  "content": [{ "type": "text", "text": "Error message describing the failure" }],
  "isError": true
}
```

**Validation errors** (Zod schema mismatch) are logged at `warn` level and include the specific field path and reason, for example:

```
Validation error: note_id: Expected 32-character hex ID
```

**Execution errors** (API failures, timeouts, etc.) are logged at `error` level and include the tool name and error message. See the [Error Handling](#error-handling) section for the full error class hierarchy.

## Sync Behaviour

- **Initial sync**: Runs on startup via SyncManager before accepting MCP requests
- **Periodic sync**: Every 5 minutes (configurable via `SYNC_INTERVAL_SECONDS`)
- **Write-triggered sync**: After every create/update/delete/untag operation (immediate, blocking until sync completes)
- **Conflict resolution**: Remote always wins (Joplin CLI built-in behaviour; conflicted copies are flagged in Joplin)
- **Serialized queue**: Prevents `SQLITE_BUSY` errors by serializing sync operations

## Security Considerations

### Token Management

The Joplin Data API uses bearer token authentication. The token is obtained automatically on startup via a `POST /auth` request and is stored in a [`GuardedString`](src/guarded-string.ts) wrapper:

- **`GuardedString`** stores the raw value in a private `#value` field, making it inaccessible through `toString()`, `toJSON()`, or template-literal coercion — all such operations return `'[REDACTED]'`
- The only way to access the actual value is via the explicit `.value` property
- This prevents accidental leakage through logging, serialisation, or error messages
- Tokens are proactively refreshed 60 seconds before expiry and re-fetched automatically on 401 responses

### TLS Requirements for Production

- The Joplin Data API always binds to `127.0.0.1` (localhost-only), so TLS between the server and the Data API is unnecessary — traffic never leaves the machine
- **The Joplin Server URL (`JOPLIN_SERVER_URL`) must use HTTPS in production** — this is enforced by the config schema (see [`src/config.ts`](src/config.ts#L5)). HTTP is only allowed when `NODE_ENV` is not set to `production`
- Joplin CLI sync traffic to Joplin Server is plain HTTP by default; ensure your Joplin Server is deployed behind a TLS-terminating reverse proxy

### Localhost-Only Defaults

- The Joplin ClipperServer hardcodes binding to `127.0.0.1`, making it unreachable from outside the container directly. To work around this, the Data API is shifted to an internal port (`JOPLIN_DATA_API_PORT + 1`, e.g. `41185`) via `joplin config api.port`, and a **socat TCP proxy** forwards `0.0.0.0:JOPLIN_DATA_API_PORT` → `127.0.0.1:(JOPLIN_DATA_API_PORT + 1)`, providing network-accessible Data API on the standard port
- In the two-container Docker deployment, the **joplin-mcp** container connects to **joplin-core** via the internal Docker network (service name `joplin-core`), not localhost
- **Docker deployment**: The **joplin-mcp** container exposes an **HTTP endpoint on port 3000** (MCP StreamableHTTP transport) mapped to the host. The Data API communication between joplin-mcp and joplin-core stays on the internal Docker network and is never exposed to the host
- The `docker-compose.yml` maps `MCP_PORT` (default `3000`) to the host for MCP client access, and optionally maps `JOPLIN_DATA_API_PORT` (default `41184`) for direct Data API access on the host. Both bind to `127.0.0.1` on the host side
- If you do not need host-side access to the Data API, remove the `ports:` block for `joplin-core` from `docker-compose.yml` to keep the Data API container-internal only

### Token Rotation Best Practices

- The Joplin Data API issues tokens with a configurable expiry (default ~55 minutes, controlled by the Joplin Data API server)
- The client automatically refreshes the token before expiry and on 401 responses
- If a token compromise is suspected, rotate the Joplin Server credentials (`JOPLIN_PASSWORD`) and restart the container — a new token will be issued on the next `POST /auth` call

### CLI Argument Sanitization

All Joplin CLI subcommands executed via [`CliExecutor`](src/cli-executor.ts) are protected by two layers of defence:

1. **Subcommand whitelist** — Only a predefined set of subcommands (sync, config, ls, cat, etc.) is allowed. Unknown subcommands are rejected before execution
2. **Shell metacharacter blocking** — Arguments containing `;`, `|`, `&`, `$`, `` ` ``, `(`, `)`, `{`, `}`, `<`, `>`, `\n` are rejected

These checks are defence-in-depth on top of Node.js `execFile`, which does not spawn a shell.

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

## Rate Limiting

The internal Joplin Data API HTTP client (`JoplinDataClient`) enforces a configurable concurrency limit to prevent overwhelming the Data API process:

- **Default max concurrency**: 5 concurrent requests
- **Configurable via**: `maxConcurrency` constructor parameter on `JoplinDataClient`
- **Behaviour**: When the limit is reached, additional requests are queued and executed as soon as a slot becomes available
- **Scope**: All Data API calls (list, get, create, update, delete, search) share the same concurrency pool
- **Per-tool**: Individual tool calls make a single Data API request, so concurrency is only relevant under parallel MCP requests

## Troubleshooting

### Authentication Failures

**Symptom**: MCP tools return `"Authentication failed"` or `AuthError`.

**Causes and fixes:**

| Cause                               | Fix                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid `JOPLIN_PASSWORD` in `.env` | Verify the password matches your Joplin Server account                                                                                 |
| Token expired before refresh        | Check that the system clock is synchronised (NTP). The client refreshes tokens proactively, but clock drift can cause premature expiry |
| Joplin Server unreachable           | Ensure `JOPLIN_SERVER_URL` is correct and the server is running. Verify TLS certificate if using HTTPS                                 |
| Data API not ready                  | Wait for the "Data API server is ready" log line before sending requests                                                               |

**Diagnostic steps:**

1. Check container logs: `docker compose logs`
2. Look for entries containing `"Failed to obtain Joplin API token"` or `"AuthError"`
3. Verify credentials by curling the Joplin Server API directly

### Sync Conflicts

**Symptom**: Logs contain `"Sync conflicts detected — remote version retained"` warnings.

**Behaviour**: The system uses a **remote-wins** conflict resolution strategy. Local changes always yield to remote versions.

**What to do:**

- Conflict notes are flagged in Joplin as conflicted copies. Check for them using the Joplin desktop/client app
- You can programmatically check conflict count via `CliExecutor.checkConflicts()`
- To resolve, review the conflicted notes in Joplin and manually merge or delete them

### Timeout Issues

**Symptom**: CLI commands fail with `"joplin CLI timed out after Nms"`.

**Causes and fixes:**

| Cause                                     | Fix                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Large initial sync (many notes/resources) | Increase `SYNC_INTERVAL_SECONDS` or let the initial sync complete — subsequent syncs are incremental            |
| Joplin Server slow to respond             | Check Joplin Server performance (CPU, memory, database). Ensure network latency is low                          |
| CLI command timeout too short             | The default timeout is 60 seconds; for extremely large operations, this can be adjusted in `CliExecutor.exec()` |

### CLI Execution Errors

**Symptom**: `CliError` with exit code, stdout, and stderr details.

**Common causes:**

- **Missing `joplin` binary**: The `joplin` CLI must be installed in the container and available on `PATH`. The Dockerfile handles this, but verify if using a custom setup
- **Config not set**: The entrypoint script configures `sync.target 10` and server credentials. If skipped, `joplin sync` will fail with a configuration error
- **Permission errors**: Ensure the Joplin CLI config directory (`~/.config/joplin`) is writable

### Rate Limiting

**Symptom**: Requests are queued or take longer than expected, but no errors are thrown.

**Behaviour**: The `JoplinDataClient` enforces a maximum of 5 concurrent API requests (configurable). Additional requests are queued and processed sequentially as slots open up.

**If you hit concurrency limits:**

- Reduce the number of parallel MCP tool calls from your AI client
- The concurrency limit is a constructor parameter on `JoplinDataClient` in [`src/data-client.ts`](src/data-client.ts). Increase it if you have a specific need for higher parallelism, but be aware of the Data API's own capacity

## Development

### Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Run in development mode with hot reload (tsx watch)
pnpm build            # Compile TypeScript (tsc)
pnpm start            # Run compiled server (node dist/mcp/entry.js)
pnpm test             # Run tests (vitest)
pnpm test:watch       # Run tests in watch mode
pnpm lint             # Lint source code (eslint)
pnpm format           # Format source code (prettier --write)
```

## Project Structure

```
src/
├── server.ts              # (obsolete — replaced by mcp/entry.ts in two-container architecture)
├── config.ts              # Zod-based environment config parsing
├── logger.ts              # Pino structured logger
├── cli-executor.ts        # Joplin CLI subprocess wrapper
├── sync-manager.ts        # Serialized sync queue orchestrator (used by Container B for write-through sync triggers)
├── data-client.ts         # Joplin Data API HTTP client (26 methods, token auth)
├── api-types.ts           # TypeScript type definitions for Joplin API
├── errors.ts              # Typed error class hierarchy
├── guarded-string.ts      # Secure string wrapper (prevents accidental secret leakage)
├── pagination.ts          # Pagination helpers (clampLimit, fetchAllPages)
└── mcp/
    ├── entry.ts           # Container B entrypoint: standalone MCP HTTP server
    ├── server.ts          # MCP server setup (stdio + StreamableHTTP transport)
    ├── schemas.ts         # Zod validation schemas for all 17 tools
    ├── tools.ts           # 17 tool handler implementations
    └── tool-registry.ts   # Tool registration and dispatch
tests/
├── cli-executor.test.ts   # CLI executor tests
├── config.test.ts         # Config parser tests
├── data-client.test.ts    # Data API client tests
├── errors.test.ts         # Error class hierarchy tests
├── integration.test.ts    # Integration tests against live Joplin Data API
├── logger.test.ts         # Logger tests
├── pagination.test.ts     # Pagination helper tests
├── sync-manager.test.ts   # Sync manager tests
└── mcp/
    ├── schemas.test.ts     # Zod schema validation tests
    ├── server.test.ts      # MCP server lifecycle tests
    ├── tool-registry.test.ts # Tool registration & dispatch tests
    └── tools.test.ts       # Tool handler tests
docs/                      # Project documentation (see root SBOM.md for dependency inventory)
scripts/
└── smoke-test.sh          # Docker container smoke test (checks container up + Data API /ping)
```

Root-level deployment files:

| File | Purpose |
| ---- | ------- |
| [`Dockerfile.core`](Dockerfile.core) | Container A: Joplin CLI + Data API + bash sync scheduler |
| [`Dockerfile.mcp`](Dockerfile.mcp) | Container B: stateless MCP HTTP server |
| [`Dockerfile.tests`](Dockerfile.tests) | Test runner container |
| [`entrypoint-core.sh`](entrypoint-core.sh) | Container A entrypoint: bash sync scheduler with extensive logging |
| [`entrypoint-mcp.sh`](entrypoint-mcp.sh) | Container B entrypoint: validates env vars and starts MCP HTTP server |
| [`docker-compose.yml`](docker-compose.yml) | Two-service orchestration with healthchecks and dependency ordering |

## Startup & Shutdown Pipeline

### Two-Container (Docker)

**joplin-core (Container A):**

1. **Validate environment variables** — [`entrypoint-core.sh`](entrypoint-core.sh) checks `JOPLIN_SERVER_URL`, `JOPLIN_USERNAME`, `JOPLIN_PASSWORD`
2. **Configure Joplin CLI** — Sets `sync.target 10` and server credentials in Joplin CLI config
3. **Extract API token** — Retrieves `api.token` from Joplin config for the Data API
4. **Start Joplin Data API with socat proxy** — Shifts Data API to internal port (`JOPLIN_DATA_API_PORT + 1`) via `joplin config api.port`, starts `joplin server start` (binds `127.0.0.1` only), then starts a `socat` TCP proxy from `0.0.0.0:JOPLIN_DATA_API_PORT` → `127.0.0.1:(JOPLIN_DATA_API_PORT + 1)`. All logs go to `/var/log/joplin/`
5. **Wait for readiness** — Polls `/ping` endpoint (up to 30 retries, 2s intervals)
6. **Perform initial sync** — `joplin sync` with retry loop (max 30 attempts)
7. **Start periodic sync** — Bash `while true` loop with configurable `SYNC_INTERVAL_SECONDS`
8. **Block on child process** — `wait` on the background Data API process
9. **Handle signals** — On `SIGTERM`/`SIGINT`: graceful shutdown with signal forwarding

**joplin-mcp (Container B):**

1. **Validate environment variables** — [`entrypoint-mcp.sh`](entrypoint-mcp.sh) checks `JOPLIN_API_TOKEN` and `JOPLIN_CORE_URL`
2. **Start Node.js server** — `node dist/mcp/entry.js`
3. **Parse config** — Zod schema validates env vars with defaults
4. **Initialize logger** — Pino structured logger at configured level
5. **Connect to joplin-core** — Pings `JOPLIN_CORE_URL/ping` to verify connectivity
6. **Initialize tool registry** — Registers all 17 MCP tool handlers (no SyncManager)
7. **Start MCP HTTP server** — Listens on `MCP_PORT` (default 3000), serves `/health` and `/mcp` endpoints
8. **Handle signals** — On `SIGTERM`/`SIGINT`: close HTTP server, exit

## Key Design Decisions

1. **Data API over CLI for data operations** — Avoids fragile CLI output parsing; uses structured HTTP API with typed responses
2. **Separation of concerns (two containers)** — Stateful backend (joplin-core) handles sync and data persistence; stateless frontend (joplin-mcp) handles MCP protocol. Independently scalable and debuggable.
3. **Bash-based sync scheduler** — Replaces the TypeScript SyncManager in Container A with a simple, reliable bash `while true` loop. Logs every sync with PASS/FAIL to `/var/log/joplin/sync.log`.
4. **Write-through sync** — Write tools trigger immediate sync so Joplin Server is always up-to-date
5. **Serialized sync queue** — Prevents concurrent sync calls causing `SQLITE_BUSY` errors
6. **Remote-wins conflict resolution** — Delegated to Joplin CLI built-in behaviour; local changes always yield to remote
7. **Token lifecycle** — Auth token obtained via `POST /auth`, reused with 60-second proactive refresh buffer before 55-minute expiry, re-fetched on 401 responses

## License

MIT
