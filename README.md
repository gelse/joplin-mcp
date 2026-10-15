# Joplin MCP Server

## What it does

An MCP (Model Context Protocol) server for Joplin. A single Docker container syncs with your Joplin Server and exposes that workspace to MCP-aware clients via 17 tools covering notes, notebooks, tags, search, and sync status. Your AI client can list, read, search, create, edit, and delete notes, notebooks, and tags; writes persist locally and reach Joplin Server on the next scheduled sync.

## Where it excels

- **Single-container deployment.** One image runs the Joplin CLI, the Data API, the sync scheduler, and the MCP HTTP server; only port 3000 is published, bound to loopback ([`docker-compose.yml`](docker-compose.yml)).
- **E2EE handled inside the container.** With `JOPLIN_MASTER_PASSWORD` set, the container decrypts after the initial sync at boot ([`entrypoint-combined.sh`](entrypoint-combined.sh)) and again after every periodic sync ([`entrypoint-combined.sh`](entrypoint-combined.sh)) — clients get plaintext titles, not ciphertext.
- **Sync-safety guarantees.** Every sync is flock-serialized to prevent overlap ([`entrypoint-combined.sh`](entrypoint-combined.sh)); a deletion circuit-breaker halts sync after mass deletions ([`entrypoint-combined.sh`](entrypoint-combined.sh)); a persistent `.sync-halt` marker refuses further syncs until you intervene ([`entrypoint-combined.sh`](entrypoint-combined.sh)).
- **Loopback-only Data API.** The Joplin Data API binds to `127.0.0.1` inside the container and is never published to the host or the Docker network ([`entrypoint-combined.sh`](entrypoint-combined.sh)).
- **Token auto-provisioning.** The Data API token is extracted from the Joplin CLI config at startup — no manual retrieval from container logs ([`entrypoint-combined.sh`](entrypoint-combined.sh)).
- **Stateless MCP transport.** Each request is handled independently with no session state, so any MCP client that speaks HTTP can connect.

## What it does not do

- **Not a Joplin client.** It exposes an existing Joplin Server account to MCP clients; it is not a note-taking app and not a full Joplin replacement.
- **Not multi-user.** One container serves one Joplin account with one API token.
- **`sync` does not force a sync.** The `sync` tool returns a status pointer; actual syncing is scheduled by the container entrypoint every `SYNC_INTERVAL_SECONDS` ([`src/mcp/tools.ts`](src/mcp/tools.ts)).
- **`search_notes` has an upstream gap.** Joplin's search index misses notes written through the Data API — see [laurent22/joplin#11631](https://github.com/laurent22/joplin/issues/11631).
- **Sync needs a compatible client version.** Joplin Server enforces a minimum client version; if the image's pinned Joplin CLI falls behind your server, sync fails silently until you upgrade the image.
- **The first destructive sync cannot be prevented.** A known upstream race can damage the profile on its first occurrence; the container limits the damage, it cannot prevent it ([`docs/sync.md`](docs/sync.md)).
- **No URL-scheme enforcement.** `JOPLIN_SERVER_URL` accepts any valid URL scheme; front the MCP endpoint with TLS yourself if you expose it beyond loopback ([`src/config.ts`](src/config.ts)).

## How to install it via image

You need Docker and a reachable Joplin Server. To run the published image:

```bash
docker run -d \
  --name joplin-mcp \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v joplin_data:/home/joplin/.config/joplin \
  -e JOPLIN_SERVER_URL=https://joplin.example.com/ \
  -e JOPLIN_USERNAME=your-email@example.com \
  -e JOPLIN_PASSWORD=your-password \
  ghcr.io/gelse/joplin-mcp:latest
```

- The `joplin_data` volume stores the Joplin profile and SQLite database — keep it, or your notes re-sync from scratch on the next start.
- If Joplin Server runs on the same host, use `https://host.docker.internal:22300` as `JOPLIN_SERVER_URL`.
- To track unreleased builds, use the `latest-testing` tag instead of `latest`.
- The container always listens on port 3000; to publish a different host port, change the left side of `-p` (see `MCP_HOST_PORT` below).

## MCP client configuration

The container serves MCP over HTTP (not stdio). Point your MCP client at the published port:

```json
{
  "mcpServers": {
    "joplin": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `JOPLIN_SERVER_URL` | **Yes** | — | Joplin Server URL (e.g. `https://joplin.example.com/`) |
| `JOPLIN_USERNAME` | **Yes** | — | Joplin Server username/email |
| `JOPLIN_PASSWORD` | **Yes** | — | Joplin Server password |
| `JOPLIN_API_TOKEN` | No | — | Data API token; auto-extracted when unset |
| `JOPLIN_DATA_API_PORT` | No | `41184` | Internal Data API listen port (rarely changed) |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `SYNC_INTERVAL_SECONDS` | No | `300` | Periodic sync interval in seconds |
| `SYNC_MAX_DELETE_COUNT` | No | `100` | Max deletions per sync before sync halts; `-1` disables the breaker, `0` trips on any deletion |
| `MCP_HOST_PORT` | No | `3000` | Host-side MCP port (used by the compose file's port mapping) |
| `JOPLIN_MASTER_PASSWORD` | No | — | E2EE master password; leave unset unless E2EE is enabled on the server |

`JOPLIN_CORE_URL` is set internally by the entrypoint and is not operator-facing — see [Migration](docs/migration.md).

## Other documentation

- [Architecture](docs/architecture.md)
- [E2EE setup](docs/e2ee.md)
- [MCP tools](docs/tools.md)
- [Sync behaviour & safety](docs/sync.md)
- [Security](docs/security.md)
- [Testing & CI](docs/testing.md)
- [Development](docs/development.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Migration](docs/migration.md)

## License

[MIT](LICENSE)
