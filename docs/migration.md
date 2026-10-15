# Migration from the Two-Container Setup

Reader: an operator upgrading an existing deployment from the old two-container topology (separate `joplin-core` + `joplin-mcp` containers) to the current single combined container.

## Migration steps

1. **Rename `MCP_PORT` → `MCP_HOST_PORT`** in your `.env` (if set) — the host-side mapping variable changed; the container itself always listens on 3000.
2. **Remove `JOPLIN_CORE_URL`** from `.env` — it is no longer operator-facing. The entrypoint exports it internally as `http://127.0.0.1:<JOPLIN_DATA_API_PORT>` because the Data API now lives in the same container ([`entrypoint-combined.sh:1133`](entrypoint-combined.sh:1133)).
3. **Stop the old stack and bring up the new one:** `docker compose down && docker compose up -d`
4. **Volumes carry over** — the `joplin_data` volume and uid 1001 are unchanged between topologies ([`docker-compose.yml:1-7`](docker-compose.yml:1)); your existing notes, E2EE master password, and sync config survive the migration untouched.

## `MCP_PORT` is canonicalized to 3000

If a stale `.env` still injects `MCP_PORT` with a non-3000 value, the entrypoint logs a warning and ignores it — the container always listens on 3000 ([`entrypoint-combined.sh:581-584`](entrypoint-combined.sh:581)). Host-side port selection is done exclusively through `MCP_HOST_PORT` in the publish mapping `127.0.0.1:${MCP_HOST_PORT:-3000}:3000`.

## What changes vs what stays

- **Changed:** one container instead of two; no internal TCP proxy; the MCP port variable renamed; `JOPLIN_CORE_URL` managed internally.
- **Unchanged:** the `joplin_data` volume, uid 1001 ownership, your notes, E2EE configuration, and sync target settings.

## Where to read next

- What the combined container runs and in which order it starts: [`docs/architecture.md`](docs/architecture.md)
