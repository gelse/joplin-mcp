# Security

Reader: an operator hardening a `joplin-mcp` deployment — how credentials are handled, what is exposed where, and which defences sit between your MCP client and your notes.

## Token management

The Data API uses two layers of token authentication:

1. **API token** — a static token passed as a `?token=` query parameter on every Data API request ([`src/data-client.ts:120-123`](src/data-client.ts:120)). It is auto-extracted from the Joplin CLI config at startup, or pre-set via `JOPLIN_API_TOKEN`.
2. **Session token** — a short-lived token (~55 minutes) obtained automatically via `POST /auth` ([`src/data-client.ts:131-150`](src/data-client.ts:131)) and sent as a `Bearer` `Authorization` header, built in `getAuthHeaders()` ([`src/data-client.ts:185`](src/data-client.ts:185)).

The session token lifecycle is handled by [`src/data-client.ts`](src/data-client.ts):

- Proactive refresh 60 seconds before expiry ([`src/data-client.ts:163-169`](src/data-client.ts:163))
- Automatic re-authentication and retry on a 401 response ([`src/data-client.ts:285-300`](src/data-client.ts:285))

## Secret redaction with `GuardedString`

`JOPLIN_PASSWORD` is wrapped in a [`GuardedString`](src/guarded-string.ts) by the config schema ([`src/config.ts:12-17`](src/config.ts:12)). The wrapper stores the raw value in a private `#value` field accessible only through the explicit `.value` property; `toString()`, `toJSON()`, and template-literal coercion all return `'[REDACTED]'` ([`src/guarded-string.ts:32-54`](src/guarded-string.ts:32)). This prevents accidental leakage of the server password through logging, serialisation, or error messages.

## TLS for production

- Traffic between the MCP server and the Data API never leaves the container (loopback `127.0.0.1:41184`), so TLS is unnecessary on that hop.
- **The MCP server accepts any URL scheme for `JOPLIN_SERVER_URL`** — the config schema validates URL shape but enforces no protocol ([`src/config.ts:6-10`](src/config.ts:6)), and `NODE_ENV` is not read by the config. If you expose the MCP endpoint beyond loopback, front it with a TLS-terminating reverse proxy yourself.
- Joplin CLI sync traffic to Joplin Server is plain HTTP by default — deploy Joplin Server behind a TLS-terminating reverse proxy.

## Localhost-only defaults

- The Data API binds to `127.0.0.1:41184` inside the container and is never exposed to the Docker network or the host.
- Only port 3000 (MCP) is published, and the compose file binds it to the host's loopback interface: `127.0.0.1:${MCP_HOST_PORT:-3000}:3000` ([`docker-compose.yml:23-27`](docker-compose.yml:23)).
- Container topology details: [`docs/architecture.md`](docs/architecture.md).

## Token rotation

- The Data API issues session tokens with a server-controlled expiry (default ~55 minutes); the client refreshes them automatically before expiry and on 401 responses.
- If credential compromise is suspected, rotate the Joplin Server password (`JOPLIN_PASSWORD`) and restart the container — a fresh session token is issued on the next `POST /auth` call, and the entrypoint re-applies the new password to the CLI config at startup.

## CLI argument sanitization

Joplin CLI invocations are protected by layered defences ([`src/cli-executor.ts`](src/cli-executor.ts)):

1. **Subcommand whitelist** — only 22 known subcommands (`sync`, `config`, `ls`, `cat`, `e2ee`, …) are accepted; anything else is rejected before execution ([`src/cli-executor.ts:27-52`](src/cli-executor.ts:27)).
2. **Shell metacharacter blocking** — arguments containing `;`, `|`, `&`, `$`, backtick, parentheses, braces, `<`, `>`, or newlines are rejected ([`src/cli-executor.ts:58`](src/cli-executor.ts:58)).
3. **No shell** — commands execute via Node's `execFile`, which never spawns a shell ([`src/cli-executor.ts:113`](src/cli-executor.ts:113)).

The first two are defence-in-depth on top of the third.

## Error class hierarchy

All typed errors derive from `Error` ([`src/errors.ts:1-56`](src/errors.ts:1), [`src/cli-executor.ts:13-21`](src/cli-executor.ts:13)):

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

How these surface to MCP clients: [`docs/tools.md#error-response-format`](docs/tools.md#error-response-format).

## Rate limiting

The internal Data API HTTP client enforces a concurrency limit to avoid overwhelming the Data API process ([`src/data-client.ts:51-114`](src/data-client.ts:51)):

- Default maximum: **5 concurrent requests** (constructor parameter `maxConcurrency`)
- Additional requests are queued and executed as slots free up — they wait, they do not fail
- All Data API calls share one pool; individual tool calls issue a single request each, so the limit only binds under parallel MCP requests

## Where to read next

- Which ports and bindings exist by design: [`docs/architecture.md`](docs/architecture.md)
- Diagnosing auth failures and syncing errors: [`docs/troubleshooting.md`](docs/troubleshooting.md)
