# Troubleshooting

Reader: an operator whose container misbehaves — symptom-first diagnostics for auth, sync, timeout, and CLI failures, plus recovery from a sync halt.

## Authentication failures

**Symptom:** MCP tools return `"Authentication failed"` or `AuthError`.

| Cause | Fix |
| ----- | --- |
| Invalid `JOPLIN_PASSWORD` | Verify the password matches your Joplin Server account |
| Token expired before refresh | Check system clock sync (NTP); the client refreshes proactively, but clock drift causes premature expiry |
| Joplin Server unreachable | Ensure `JOPLIN_SERVER_URL` is correct and the server is running; verify the TLS certificate if using HTTPS |
| Data API not ready | Wait for the `"Data API is healthy"` log line ([`entrypoint-combined.sh:661`](entrypoint-combined.sh:661)) before sending requests |

Diagnostic steps:

1. Check container logs: `docker compose logs`
2. Look for entries containing `"Could not read Joplin API token after N attempts"` ([`entrypoint-combined.sh:715`](entrypoint-combined.sh:715)) or `"AuthError"` — the first means the entrypoint could not extract a token from the CLI config or `settings.json` after its retries
3. Verify credentials by querying the Joplin Server API directly

Token handling background: [`docs/security.md#token-management`](docs/security.md#token-management).

## Sync conflicts

**Symptom:** conflicted copies flagged in a Joplin client. The combined container does not log conflicts — the `"Sync conflicts detected — remote version retained"` line ([`src/cli-executor.ts:173`](src/cli-executor.ts:173)) belongs to the legacy stdio path only.

**Behaviour:** resolution is remote-wins (Joplin CLI built-in). Conflicted copies are flagged in Joplin; you can count them programmatically via `CliExecutor.checkConflicts()` ([`src/cli-executor.ts:198-202`](src/cli-executor.ts:198)).

**What to do:** review the conflicted notes in a Joplin client and merge or delete them manually. Sync-halts are a different failure class — see [Recovery after a sync halt](#recovery-after-a-sync-halt) and [`docs/sync.md#halt-markers-and-recovery`](docs/sync.md#halt-markers-and-recovery).

## Timeout issues

**Symptom:** `"joplin CLI timed out after Nms"`.

| Cause | Fix |
| ----- | --- |
| Large initial sync | Let it complete — subsequent syncs are incremental; see [`docs/sync.md#initial-sync-throughput`](docs/sync.md#initial-sync-throughput) |
| Joplin Server slow | Check server CPU/memory/database and network latency |
| Timeout too short for the operation | The default is 60 seconds ([`src/cli-executor.ts:106`](src/cli-executor.ts:106), raise it via the `timeoutMs` parameter to `CliExecutor.exec()`; the message names the exact limit hit ([`src/cli-executor.ts:147`](src/cli-executor.ts:147)) |

## CLI execution errors

**Symptom:** `CliError` carrying exit code, stdout, and stderr.

Common causes:

- **Missing `joplin` binary** — the Dockerfile installs it; verify if you run a custom setup
- **Config not set** — the entrypoint configures `sync.target 10` and server credentials at startup ([`entrypoint-combined.sh:606`](entrypoint-combined.sh:606)); without it `joplin sync` fails with a configuration error
- **Permission errors** — the Joplin CLI config directory (`~/.config/joplin`) must be writable

## Rate limiting

**Symptom:** requests queue or respond slowly, but no errors are thrown.

**Behaviour:** the Data API client caps concurrency at 5 and queues excess requests. Reduce parallel MCP tool calls from your client, or raise `maxConcurrency` on `JoplinDataClient` if you specifically need more parallelism — see [`docs/security.md#rate-limiting`](docs/security.md#rate-limiting).

## E2EE symptoms

Missing notes despite `SYNC_PASS`, encrypted titles, or halt markers tagged `E2EE_*`: see [`docs/e2ee.md`](docs/e2ee.md) — it owns the decrypt pipeline, the halt markers, and the reproduction test.

## Recovery after a sync halt

**Symptom:** logs repeat `Sync halt marker exists — refusing to sync` with a tag such as `[SYNC_ABORT]`, `[CIRCUIT_BREAKER]`, or `[E2EE_*]`. The tag-aware refusal routes you to the matching cause ([`entrypoint-combined.sh:107-118`](entrypoint-combined.sh:107)).

**Recovery:** investigate the cause recorded in the marker (the full damage-limitation context is in [`docs/sync.md#sqlite_busy-and-damage-limitation`](docs/sync.md#sqlite_busy-and-damage-limitation)), then remove the marker:

```bash
docker exec joplin-mcp rm /home/joplin/.config/joplin/.sync-halt
```

The next scheduled sync resumes normally; until then every sync, including the shutdown final sync, is refused.

## Where to read next

- Sync modes, SQLITE_BUSY, and halt markers in full: [`docs/sync.md`](docs/sync.md)
- E2EE pipelines and their gates: [`docs/e2ee.md`](docs/e2ee.md)
- Token lifecycle and hardening: [`docs/security.md`](docs/security.md)
