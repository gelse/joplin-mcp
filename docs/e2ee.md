# End-to-End Encryption (E2EE)

Reader: an operator running an E2EE-enabled Joplin workspace against this container — what the master password does, how the container decrypts, and how to tell E2EE apart from other failures.

## What E2EE means here

With E2EE enabled, Joplin encrypts all note content on the client before it reaches the server — the server only ever sees ciphertext, and decryption happens client-side with the master password. This container is such a client: without the master password it cannot encrypt writes for upload, and sync can still misleadingly report success.

## Setting the master password

Preferred (declarative): add `JOPLIN_MASTER_PASSWORD` to your `.env` (or pass it via `docker run -e`). The entrypoint applies it via `joplin config encryption.masterPassword` on every fresh container start, before the initial sync ([`entrypoint-combined.sh:618-621`](entrypoint-combined.sh:618)).

Fallback (manual, after container start):

```bash
docker exec joplin-mcp joplin config encryption.masterPassword 'THE_PASSWORD'
docker restart joplin-mcp
```

Replace `THE_PASSWORD` with the same master password used when E2EE was enabled on Joplin Server. The password persists in the `joplin_data` volume; with the environment variable set, the entrypoint re-applies it on every start.

## `joplin e2ee decrypt` does not persist the password

`joplin e2ee decrypt` decrypts data for the current session only and does not store the password for future syncs. The CLI reads the master password from `joplin config encryption.masterPassword`; in Joplin CLI 3.7.1 the `-p` option is only consumed by `e2ee enable` ([`entrypoint-combined.sh:818-822`](entrypoint-combined.sh:818)). Using `decrypt` as your setup step causes encrypted items to silently fail to upload on subsequent syncs — always configure via `joplin config encryption.masterPassword`.

## What the container does

When `JOPLIN_MASTER_PASSWORD` is set, the entrypoint runs a fail-closed decrypt pipeline after the initial sync, before the periodic sync loop starts ([`entrypoint-combined.sh:799-1015`](entrypoint-combined.sh:799)):

1. **Master-key preflight** — a read-only SQLite probe counts master keys pulled by the sync. Zero keys means E2EE is disabled (or was never enabled) server-side, so decrypt cannot succeed: the entrypoint skips the retry loop, writes the halt marker `[E2EE_NO_MASTER_KEY]` ([`entrypoint-combined.sh:892`](entrypoint-combined.sh:892)), and does not start the periodic loop.
2. **Bounded decrypt** — `joplin e2ee decrypt --force` runs with up to 4 attempts and 5 s backoff between attempts ([`entrypoint-combined.sh:904-905`](entrypoint-combined.sh:904)). All attempts failing writes `[E2EE_DECRYPT_FAIL]` ([`entrypoint-combined.sh:931`](entrypoint-combined.sh:931)) and stops the periodic loop.
3. **Verification gate** — a read-only SQLite probe counts remaining encrypted items across notes, folders, resources, tags, note-tag links, and revisions. Any non-zero count — or a failed probe — writes `[E2EE_DECRYPT_INCOMPLETE]` ([`entrypoint-combined.sh:988-993`](entrypoint-combined.sh:988)) and stops the periodic loop. A partially completed decrypt can exit 0; only this gate catches it.

Notes that arrive **after** boot reach the container through a periodic sync. Every periodic-sync cycle therefore also runs a post-sync decrypt pass ([`entrypoint-combined.sh:370-481`](entrypoint-combined.sh:370), detailed in [`docs/sync.md#post-sync-decrypt-in-the-periodic-loop`](docs/sync.md#post-sync-decrypt-in-the-periodic-loop)). Unlike the boot path, a periodic decrypt failure never halts the container — it is logged, and the next cycle retries naturally.

All halt markers block further syncs until removed; recovery steps are in [`docs/troubleshooting.md#recovery-after-a-sync-halt`](docs/troubleshooting.md#recovery-after-a-sync-halt).

## Resolved: encrypted titles served as plaintext

Earlier container versions served E2EE-encrypted notebook titles as ciphertext through `list_notebooks` even with the master password configured. The container now triggers decryption itself: after the initial sync it runs the bounded decrypt, verifies zero items remain encrypted, and only then starts the periodic sync loop and the MCP server (MCP starts last — see [`docs/architecture.md#startup-pipeline`](docs/architecture.md#startup-pipeline)). The Data API then serves plaintext titles without a container restart — the behavior the reproduction test below observes and now guards against regressions.

## How to tell if E2EE is the problem

If notes are missing from Joplin Server despite the container reporting `SYNC_PASS`, check whether E2EE is enabled on the server and whether `JOPLIN_MASTER_PASSWORD` is configured in the container. For sync-side failures that are not E2EE-related, see [`docs/sync.md`](docs/sync.md); for log-level diagnostics, see [`docs/troubleshooting.md`](docs/troubleshooting.md).

## E2EE reproduction test

A gated container integration test ([`tests/container/e2ee-encrypted-titles-repro.test.ts`](tests/container/e2ee-encrypted-titles-repro.test.ts)) reproduces the original encrypted-titles bug against a real Joplin Server and asserts the safe behavior: non-empty plaintext titles and no remaining encrypted blobs. It is skipped unless `RUN_E2EE_REPRO_TESTS=1` ([`tests/container/e2ee-encrypted-titles-repro.test.ts:30-31`](tests/container/e2ee-encrypted-titles-repro.test.ts:30)); default CI is unaffected.

Requirements:

- A real `joplin/server:latest` container with E2EE enabled and an account matching the credentials used in the run
- `JOPLIN_MASTER_PASSWORD` set to the password used to encrypt the fixtures
- A fresh `joplin_data` volume

Local one-shot run:

```bash
RUN_E2EE_REPRO_TESTS=1 ./scripts/run-integration-tests.sh
```

The runner ([`scripts/run-integration-tests.sh`](scripts/run-integration-tests.sh)) brings up the real Joplin Server under the compose profile `e2ee-repro` ([`docker-compose.test.yml:49`](docker-compose.test.yml:49)), runs the one-shot seed container to create an encrypted notebook + note, recreates the combined container against the seeded server, and runs the repro. Optionally, `E2EE_REPRO_SERVER_URL` overrides the server URL the recreated container syncs against (default `http://joplin-server:22300`, [`scripts/run-integration-tests.sh:97`](scripts/run-integration-tests.sh:97)).

To prove the repro can actually fail, set `E2EE_REPRO_SERVER_URL` to an unreachable host (for example `http://nonexistent.example.invalid:1`): the recreated container then cannot sync the fixture, and the test's `FIXTURE_NOT_SYNCED` anti-vacuous gate ([`tests/container/e2ee-encrypted-titles-repro.test.ts:248`](tests/container/e2ee-encrypted-titles-repro.test.ts:248)) exits the run non-zero — the gate exists so a "pass" can never mean "nothing was tested".

## Where to read next

- Startup ordering and the boot decrypt pipeline in context: [`docs/architecture.md`](docs/architecture.md)
- Sync serialization, halt markers, and SQLITE_BUSY damage limitation: [`docs/sync.md`](docs/sync.md)
- Log strings and recovery commands: [`docs/troubleshooting.md`](docs/troubleshooting.md)
