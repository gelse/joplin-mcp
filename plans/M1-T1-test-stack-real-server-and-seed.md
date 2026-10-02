# M1-T1 — Test stack: real Joplin Server + one-shot seed container

> Subtask of **M1 — E2EE Encrypted Titles Reproduction Integration Test**.
> Belongs to the verification milestone (M1). Implementation starts in a
> fresh session from this file alone.

## 1. Header

- **Subtask ID:** M1-T1
- **Milestone:** M1 (verification only — no fix)
- **Dependencies (other subtask IDs):** none (M1-T1 is the first; M1-T2 and M1-T3 depend on this)
- **What it delivers:** A profile-gated `joplin-server` service + one-shot `joplin-e2ee-seed` service in `docker-compose.test.yml`; helpers in `tests/container/helpers.ts` for the seed-time surface; updated hard-coded env values in `joplin-mcp` to `${VAR:-default}` form so the runner script can substitute them when active.

> **Status: IMPLEMENTED and VERIFIED end-to-end.** All §7 verification commands pass.
> The stack was additionally proven live: `joplin-server` → healthy, `joplin-e2ee-seed`
> → exit 0, `joplin-mcp` → healthy, and `list_notebooks` returned `"title": ""` —
> issue #29 reproduces. §5's literal YAML required **five forced corrections** found by
> running `joplin/server:latest`; they are itemized with evidence in **§9.3**, and the
> research spike is answered in **§9.1**. **§5 should be read as superseded by §9.3.**
> §9.4 is the env contract M1-T4/M1-T5 must satisfy; §10.1 lists CLI facts M1-T2 needs.
> One M1-T1 acceptance criterion is unmet by design: `joplin-e2ee-seed` cannot be run
> to completion until M1-T2 lands `tests/container/fixtures/e2ee-seed.sh` — the proof
> run used a throwaway seeder that was deleted afterward.

## 2. Full problem context

GitHub issue #29 reports that the combined container
(`ghcr.io/gelse/joplin-mcp:latest`) serves E2EE-encrypted notebook titles
as-is via `list_notebooks` despite `JOPLIN_MASTER_PASSWORD` being set. The
reporter's `list_notebooks` call returns notebooks with **empty `title`
fields** (or `encryption_applied=1` with non-empty
`encryption_cipher_text`). Sync reports `SYNC_PASS` — `README.md:60`
corroborates: "the sync process will misleadingly report `SYNC_PASS`" for
the upload-only path; the same blind-spot applies on the download path
because `check_sync_errors()` only pattern-matches literal "Master key is
not loaded" and misses the actual wording "no master key is currently
loaded" emitted by the DecryptionWorker.

The reporter's workaround was: run `joplin e2ee decrypt` manually inside
the container. This **first failed** with *"DecryptionWorker: cannot start
because no master key is currently loaded"* — and then succeeded after a
short retry (likely master-key propagation timing). After manual decrypt,
**204 items** were decrypted in the SQLite DB, and the Data API then
served plaintext without a server restart. Only then did `list_notebooks`
work as expected.

The reproducer (this milestone, M1-T3) needs: a real Joplin Server with
E2EE enabled, with ≥1 encrypted notebook + ≥1 encrypted note created via
the seed container **on the server** (so the encrypted ciphertext arrives
via sync, mirroring the reporter's bug path). Pre-baking a SQLite DB is
rejected (brittle across joplin versions; defeats end-to-end value of the
repro). Seeding via local-profile-only is rejected (bug is about download,
not creation). One-shot seed container running the `joplin` CLI against
the same server is the chosen strategy.

## 3. Authoritative investigation evidence (with file:line)

- **entrypoint-combined.sh**:306-309 — only master-password code; no decrypt trigger:
  ```sh
  if [ -n "${JOPLIN_MASTER_PASSWORD:-}" ]; then
        joplin config encryption.masterPassword "${JOPLIN_MASTER_PASSWORD}"
        log "INFO" "Master password configured from environment"
    fi
  ```
- **entrypoint-combined.sh**:294-297 — `sync.target` config (used in seeding script too):
  ```sh
  joplin config sync.target 10
  joplin config "sync.10.path" "${JOPLIN_SERVER_URL}"
  joplin config "sync.10.username" "${JOPLIN_USERNAME}"
  joplin config "sync.10.password" "${JOPLIN_PASSWORD}"
  ```
- **entrypoint-combined.sh**:443 — `flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin sync'`. Insertion site for the eventual M2-T1 decrypt step.
- **entrypoint-combined.sh**:333-335 — `nohup joplin server start &` (Data API; **runs before** sync; relocates under M2-T2).
- **src/mcp/tools.ts:45-47** — `listNotebooks` → `ctx.client.getAllFolders()`:
  ```ts
  export const listNotebooks: ToolHandler<object, Folder[]> = async (_input, ctx) => {
    return ctx.client.getAllFolders();
  };
  ```
- **src/data-client.ts:479-482, 491-493** — `listFolders` → `GET /folders?limit=100&page=N`; `getAllFolders` iterates pages. No decryption, no field restriction.
- **src/api-types.ts:37-51** — `Folder` interface. **`encryption_cipher_text` at `:45`, `encryption_applied` at `:46`** (correction vs. source plan's cited 42–56; substance unchanged: fields carried, never inspected). No grep hit for `decrypt` in `src/`.
- **src/cli-executor.ts:27-49** — `ALLOWED_SUBCOMMANDS` whitelist: `e2ee` is NOT in the list. The whitelist is for the Node CLI in src/; the entrypoint uses the global `joplin` binary which is unrestricted, so `joplin e2ee enable` / `joplin e2ee decrypt` work fine in the entrypoint and the seed script.
- **reports/container/joplin-mcp.log:38,42-43,50-51** — `"e2ee/utils: Trying to load 0 master keys... Loaded master keys: 0"`. The pair at 42-43 is verbatim. Confirms per-CLI-process master-key loading.
- **docker-compose.test.yml:1-44 (full file)** — currently 44 lines, no `profiles:` keys. Services: `joplin-mcp` (image `joplin-mcp-combined:test`, env dummy URL + SYNC_INTERVAL_SECONDS=9999, healthcheck `/ping`+`/health`, init:true) and `test-runner` (image `joplin-api-tests:test`, env MCP_URL+RUN_SYNC_LOCK_TESTS, mounts `vitest.config.container.ts`+`./reports/container`+`/var/run/docker.sock`). Volume: `joplin_data`.
- **Dockerfile.combined:86-87** — `HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=90s CMD curl -f http://127.0.0.1:41184/ping && curl -f http://127.0.0.1:3000/health || exit 1`.
- **tests/container/sqlite-busy-repro.test.ts:23-26** — gating precedent: `const RUN_SYNC_LOCK_TESTS = process.env['RUN_SYNC_LOCK_TESTS'] === '1'; const describeIfSyncLock = RUN_SYNC_LOCK_TESTS ? describe : describe.skip;`. M1-T3 mirrors this for `RUN_E2EE_REPRO_TESTS`.

## 4. Scope

**Files to change / add:**
- **modify** `docker-compose.test.yml` (currently untracked but in working tree):
  - **modify** the `joplin-mcp` service's environment block: replace the four hardcoded values (`JOPLIN_SERVER_URL`, `JOPLIN_USERNAME`, `JOPLIN_PASSWORD`, plus a new `JOPLIN_MASTER_PASSWORD`) with `${VAR:-default}` form so the runner script (M1-T4) can override them when the profile is active. Default values remain `https://dummy-joplin-server.example.com`, `test-user`, `test-password`. No `JOPLIN_MASTER_PASSWORD` default (omit line if not set, preserving today's no-master-password behavior for non-e2ee-repro runs).
  - **add** `joplin-server` service (image `joplin/server:latest`, gated by `profiles: ["e2ee-repro"]`).
  - **add** `joplin-e2ee-seed` service (image `joplin-mcp-combined:test` — reuse the combined image; the seed script uses the same `joplin` CLI; gated by `profiles: ["e2ee-repro"]`).
- **modify** `tests/container/helpers.ts` — add helpers: `waitForServerReady(serverUrl, timeoutMs)` and `probeServerForEncryptedFixture(serverUrl, apiToken, timeoutMs)` (probes the Joplin Server REST API for `encryption_applied=1` on the seeded notebook). If the REST API does not expose `encryption_applied` (spike below), the seed-time mechanism-validation gate reads a marker file written by the seeder at seed time (Risk #5 / Gap 3 in the index).

**Files NOT to touch:**
- `entrypoint-combined.sh` (M1 is verification-only; the combined container's startup behavior is unchanged in M1).
- `Dockerfile.combined` (M2-T3 changes it).
- `.github/workflows/integration-tests.yml` (M1-T5).
- `scripts/run-integration-tests.sh` (M1-T4 — though M1-T4 calls the runner script this subtask sets up).

## 5. Exact behavior required

### docker-compose.test.yml — concrete changes

Replace `joplin-mcp` service env block (currently lines 7-12):

```yaml
environment:
  - JOPLIN_SERVER_URL=${JOPLIN_SERVER_URL:-https://dummy-joplin-server.example.com}
  - JOPLIN_USERNAME=${JOPLIN_USERNAME:-test-user}
  - JOPLIN_PASSWORD=${JOPLIN_PASSWORD:-test-password}
  - JOPLIN_MASTER_PASSWORD=${JOPLIN_MASTER_PASSWORD:-}
  - SYNC_INTERVAL_SECONDS=9999
  - LOG_LEVEL=warn
```

Add two new services (after `joplin-mcp`, before `test-runner`):

```yaml
joplin-server:
  image: joplin/server:latest
  profiles: ["e2ee-repro"]
  environment:
    - APP_PORT=22300
    - APP_BASE_URL=http://joplin-server:22300
    - DB_CLIENT=sqlite
    - SQLITE_DATABASE=joplin.sqlite
    # First-boot admin (used by the seed script to authenticate):
    - APP_ADMIN_USERNAME=${JOPLIN_E2EE_ADMIN_USERNAME:-test-user}
    - APP_ADMIN_PASSWORD=${JOPLIN_E2EE_ADMIN_PASSWORD:-test-password}
  volumes:
    - joplin_server_data:/data
  healthcheck:
    test: ['CMD-SHELL', 'curl -f http://127.0.0.1:22300/api/ping || exit 1']
    interval: 2s
    timeout: 5s
    retries: 30
    start_period: 10s

joplin-e2ee-seed:
  image: joplin-mcp-combined:test
  profiles: ["e2ee-repro"]
  depends_on:
    joplin-server:
      condition: service_healthy
  environment:
    - JOPLIN_SERVER_URL=http://joplin-server:22300
    - JOPLIN_USERNAME=test-user
    - JOPLIN_PASSWORD=test-password
    - JOPLIN_MASTER_PASSWORD=${JOPLIN_MASTER_PASSWORD:-}
    - LOG_LEVEL=info
  volumes:
    - joplin_seed_data:/home/joplin/.config/joplin
    - ./tests/container/fixtures/e2ee-seed.sh:/seed.sh:ro
  entrypoint: ['bash', '/seed.sh']
  restart: 'no'
```

Add two new volumes to the bottom:

```yaml
volumes:
  joplin_data:
  joplin_server_data:
  joplin_seed_data:
```

Also update the existing `joplin-mcp` service's `depends_on` to include `joplin-e2ee-seed` **only when the profile is active** (otherwise the dependency is dangling and compose fails). Use the conditional form:

```yaml
joplin-mcp:
  ...existing...
  depends_on:
    joplin-e2ee-seed:
      condition: service_completed_successfully
      required: false
```

`required: false` (compose 2.32+) makes the dependency a soft link — when the source service is not present in the active profile, the dependent starts regardless. When the profile is active and the seeder has succeeded, the combined container waits.

**Note on `container_name`:** the existing compose does not pin `container_name` (M11 invariant; `tests/integration-runner-config.test.ts:42` enforces `not.toMatch(/^\s*["']?container_name["']?\s*:/m)`). Do not add `container_name` to the new services.

**Note on `MCP_URL` reachability:** `MCP_URL=http://joplin-mcp:3000/` in the `test-runner` service remains unchanged (service-name DNS is project-scoped; works regardless of `container_name`).

### helpers.ts — concrete additions

Add (at end of `tests/container/helpers.ts`):

```ts
/**
 * Poll a URL with `curl -sf` until it responds 2xx, up to `timeoutMs`.
 * Used to confirm joplin-server is up before the seed container runs.
 */
export function waitForHttp(
  url: string,
  timeoutMs = 30_000,
  intervalMs = 1_000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      exec(`curl -sf '${url}' -o /dev/null`, (err) => {
        if (!err) return resolve();
        if (Date.now() - start >= timeoutMs) return reject(new Error(`Timeout waiting for ${url}`));
        setTimeout(tick, intervalMs);
      });
    };
    tick();
  });
}
```

(`exec` is imported from `child_process`; add to the import block.)

The `probeServerForEncryptedFixture()` helper is defined in M1-T3 because the gate logic lives there. M1-T1 only exposes the seed-time surface (the seeder is responsible for writing whatever marker the gate will read).

## 6. Acceptance criteria

- `docker compose -f docker-compose.test.yml config` succeeds with no errors.
- Without `--profile e2ee-repro` (default CI), the new services are absent from `docker compose ps`; behavior is identical to today (verified by running the existing test suite green).
- With `--profile e2ee-repro`, `joplin-server` and `joplin-e2ee-seed` are present and start in correct order: `joplin-server` becomes healthy, then `joplin-e2ee-seed` runs to completion (exit 0), then `joplin-mcp` starts.
- `JOPLIN_SERVER_URL`/`JOPLIN_USERNAME`/`JOPLIN_PASSWORD` are overridable through the runner script's environment when the profile is active (verified by inspection: docker compose config prints the substituted value).
- The `tests/integration-runner-config.test.ts` invariants remain green after this change (no `container_name` added; `JOPLIN_CONTAINER` resolution path unchanged).

## 7. Verification commands

1. `docker compose -f docker-compose.test.yml config` → exit 0; prints YAML.
3. `docker compose -f docker-compose.test.yml --profile e2ee-repro config` → exit 0; prints YAML with `joplin-server` and `joplin-e2ee-seed` services and the `required: false` dep declared.
3. `pnpm test` (unit tests) → green; `tests/integration-runner-config.test.ts` invariants intact.
4. Manual: `JOPLIN_SERVER_URL=http://example.com docker compose -f docker-compose.test.yml --profile e2ee-repro config | grep JOPLIN_SERVER_URL` → shows the substituted value (proves `${VAR:-default}` form takes effect).
5. Manual: `docker compose -f docker-compose.test.yml config | grep container_name` → exit 1 (no `container_name:` lines).

## 8. Risks / gotchas

- **Gap 3 — does the Joplin Server REST API expose `encryption_applied`?** Spike assigned below. If no API, the seed-time gate uses a marker file: the seeder writes `/home/joplin/.config/joplin/.e2ee-fixture-seed` containing the seeded notebook id + a JSON `{"encryption_applied": "1"}` line, and the gate (defined in M1-T3) reads that. **Escape hatch:** the seeder container mounts the data volume (`joplin_seed_data`) which is shared with the combined container via the script — but that conflicts with isolation. Cleaner escape: the seeder writes the marker to a host-mounted directory (e.g. `./tests/container/fixtures/.seed-marker.json`) and the gate reads it through `readFileSync` on the host. (Choose this cleaner form unless evidence forces otherwise.)
- **Composer profile support:** the existing compose file (Compose Spec) supports `profiles:` natively; required: false for soft dependencies is supported in Compose 2.32+ (the runner uses Docker Compose that ships with the docker CLI used today; verify `docker compose version` ≥ 2.32 on the devcontainer/CI; if not, use the absolute path: hardcode the dependency as a post-profile conditional via a separate compose file `docker-compose.test-e2ee.yml` that extends `docker-compose.test.yml`. Document the escape hatch.)
- **joplin/server:latest drift changes the fingerprint** — not a risk per Decision 2 (drift accepted); first failure in the gated opt-in job is the discovery mechanism.

## 9. Research spikes assigned

### 9.1 ANSWERED — does the Joplin Server REST API expose `encryption_applied` on items?

**NO.** The escape hatch applies; M1-T3's gate must read the seeder's marker file.

Evidence (verified against `joplin/server:latest`, digest `sha256:3f7b8529…`, Sep2026 build):

- Joplin Server has **no item-list route at all**. `src/routes/api/items.ts` registers only
  `api/items/:id`, `api/items/:id/content`, `api/items/:id/delta`,
  `api/items/:id/children` — all id-scoped. `GET /api/items?limit=5` returns
  `404 {"error":"Not found: GET api/items"}` (verified live).
  There is likewise no `api/folders` route: notebooks exist only as `type=2` items.
- `encryption_applied` is stored server-side as the `jop_encryption_applied` column
  (`src/services/database/types.ts:542`, migration `20210412110640_item_refactor.ts:41`)
  and is consumed only by sync filtering
  (`src/utils/joplinUtils.ts:425`). Nothing projects it onto a REST response.

**Consequence for M1-T3:** the mechanism-validation gate reads the marker file, and the
marker surface is the seeder's volume `joplin_seed_data` (mounted at
`/home/joplin/.config/joplin` in the `joplin-e2ee-seed` service). M1-T3 reads it from
inside `test-runner` via `docker run --rm -v <project>_joplin_seed_data:/data …`,
the same docker.sock mechanism `tests/container/sqlite-busy-repro.test.ts` already uses.

### 9.2 ANSWERED — what the Data API actually returns for an E2EE notebook

**`title` is empty; `encryption_applied` / `encryption_cipher_text` are NOT in the
response at all.** Live `list_notebooks` output from the combined container after the
M1-T1 stack reproduced the bug:

```json
[{ "id": "d4b802f32fd942b3b83237891eb55ddc", "parent_id": "", "title": "", "deleted_time": 0 }]
```

This contradicts the assumption in §2 and in the M1 index that
`list_notebooks` returns `encryption_cipher_text` / `encryption_applied`. The Data
API's `/folders` route projects only `id`, `parent_id`, `title`, `deleted_time`.
**M1-T3's failing assertion must therefore be on `title`, not on
`encryption_applied`** — the safe-behavior assertion stays as-is
(non-empty plaintext titles), but any gate that looks for an encryption flag over MCP
has nothing to look at. `Folder` in `src/api-types.ts:37-51` carries those fields
because the type is shared, not because the route returns them.

## 9.3 Deviations from §5 of this plan (forced by verified upstream behavior)

Each was found by running `joplin/server:latest`, not by guessing.

1. **`APP_ADMIN_USERNAME` does not exist.** Joplin Server creates exactly one account
   and its email is hardcoded: `defaultAdminEmail = 'admin@localhost'`
   (`src/db.ts:38`), created in migration `20190913171451_create.ts:102` with
   `config().defaultAdminPassword` = `DEFAULT_ADMIN_PASSWORD` env or `'admin'`
   (`src/config.ts:206`). The delivered compose uses
   `- DEFAULT_ADMIN_PASSWORD=${JOPLIN_PASSWORD:-admin}` and
   `JOPLIN_USERNAME=${JOPLIN_USERNAME:-admin@localhost}` in the seeder.
   Verified live: `POST /api/sessions` with `admin@localhost` / `admin` → 200.

2. **The healthcheck cannot use `curl`.** The image is Debian bookworm with no `curl`
   and no `wget` (both purged by the Node base image's `apt-mark auto` sweep); Node 24
   is present. Delivered form:
   `node -e "fetch('http://joplin-server:22300/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.

3. **The healthcheck cannot use `127.0.0.1`, and neither can any client.**
   `APP_BASE_URL` is an origin allow-list: `execRequest` rejects any request whose
   `Host` differs from the route's base URL (`src/utils/routeUtils.ts:217` →
   `isValidOrigin`, line 170). Verified live — probing `127.0.0.1:22300/api/ping`
   yields `404 Invalid origin: http://127.0.0.1:22300`; `joplin-server:22300` yields
   `200 {"status":"ok"}`. The container resolves its own service name via Docker DNS,
   so the probe works.

4. **The `joplin_server_data` volume at `/data` cannot work; it was dropped.**
   The image has no `/data` directory, so Docker creates the mount point root-owned
   while the server runs as uid 1001 (`joplin`): verified live —
   `db: Could not connect … SQLITE_CANTOPEN: unable to open database file`, forever,
   healthcheck never passes. Delivered form puts the DB at
   `/home/joplin/packages/server/joplin.sqlite` (app dir is joplin-owned) and keeps
   **no volume** for the server. Two reasons this is not a regression: the repro wants
   a freshly seeded server per run, and `DEFAULT_ADMIN_PASSWORD` is only honored on
   first boot, so a persisted DB would silently ignore a changed password.

   **`joplin_data` and `joplin_seed_data` are unaffected** — those mount points exist
   in the combined image and are already joplin-owned, so the named volumes inherit
   correct ownership (verified: the seeder ran, synced, and exited 0).

5. **`healthcheck: disable: true` on `joplin-e2ee-seed`.** The combined image's
   HEALTHCHECK (`Dockerfile.combined:86-87`) probes the Data API and MCP server, which
   the seeder never starts — inherited, it reports `unhealthy` for its whole life.
   `compose up --wait` keys off `service_completed_successfully` here, so the probe is
   dropped rather than left to fail.

## 9.4 Environment contract for M1-T4 / M1-T5

Under `--profile e2ee-repro`, the runner must export — Compose substitutes them into
both the seed and the combined container:

| Variable | Value | Notes |
|---|---|---|
| `JOPLIN_SERVER_URL` | `http://joplin-server:22300` | must match `APP_BASE_URL` (deviation 3) |
| `JOPLIN_USERNAME` | `admin@localhost` | hardcoded upstream account (deviation 1) |
| `JOPLIN_PASSWORD` | `admin` | also becomes `DEFAULT_ADMIN_PASSWORD` |
| `JOPLIN_MASTER_PASSWORD` | any test value | required by the seeder |

Only `JOPLIN_MASTER_PASSWORD` has no working default; `M1-T2`'s script guards it with
`${JOPLIN_MASTER_PASSWORD:?…}`.

## 10. Handoff note

The next subtask in the sequence is **M1-T2 (e2ee-seed-fixture-script)**, which depends on this. M1-T2 implements `tests/container/fixtures/e2ee-seed.sh` — the script the `joplin-e2ee-seed` container runs. The script MUST:
- assume `JOPLIN_SERVER_URL=http://joplin-server:22300` (matches the docker-compose env this subtask sets);
- assume `JOPLIN_USERNAME`/`JOPLIN_PASSWORD`/`JOPLIN_MASTER_PASSWORD` are set in the env;
- produce a deterministic notebook titled `EncryptedNotebook` and a note titled `EncryptedNote`, encrypted on the server, before exiting 0;
- write the seed-time marker (per Gap 3 escape hatch) so M1-T3's gate can read it without depending on the Joplin Server REST API. **Marker surface is the `joplin_seed_data` volume**, i.e. `${HOME}/.config/joplin/.e2ee-seed-marker.json` inside the seeder — this is what M1-T2 and M1-T3 already specify, and §9.1 confirms it is the only option.

### 10.1 Verified CLI facts for M1-T2 (joplin CLI 3.7.1, `joplin-mcp-combined:test`)

Found while proving the stack end-to-end with a throwaway seeder. Each was a live failure
first, then a live fix — do not re-derive these:

- **`joplin e2ee enable -p "$PW"`, not `--master-password`.** The flag is
  `-p, --password` (`/usr/local/lib/node_modules/joplin/command-e2ee.ts`, `options()`
  line ~28). `--master-password` is silently ignored and the command then blocks forever
  on `Enter master password:` — fatal in a non-TTY container. Verified: `-p` exits 0,
  `joplin e2ee status` → `Encryption is: Enabled`.
- **`encryption.password` is not a config key** (`joplin config encryption.password` →
  `Unknown key: encryption.password`). `joplin config encryption.masterPassword "$PW"`
  (what `entrypoint-combined.sh:306` uses) is accepted but is a *different* thing from
  what `e2ee enable` needs.
- **The commands are `mkbook` / `mknote`, not `mk`.** `joplin help` lists
  `attach, batch, cat, clear, config, cp, done, e2ee, edit, export, geoloc, help,
  import, keymap, ls, mkbook, mknote, mktodo, mv, ren, restore, rmbook, rmnote, server,
  set, share, status, sync, tag, todo, undone, use, version`.
- **Redirect stdin (`</dev/null`) on every invocation.** The CLI opens an interactive
  pane when stdin is a pipe/TTY.
- `joplin sync` against this server prints `Completed:` on the first (empty) sync and
  `Created remote items: N` once items exist — a usable success signal.

### 10.2 Verified ordering (observed, not assumed)

`docker compose --profile e2ee-repro up -d joplin-mcp` produced:

```
joplin-e2ee-seed   Exited (0)
joplin-mcp         Up (healthy)
joplin-server      Up (healthy)
```

`joplin-server` healthy → `joplin-e2ee-seed` exit 0 → `joplin-mcp` healthy.

### 10.3 What the proof run established about the bug itself

The throwaway seeder created `EncryptedNotebook` on the server with E2EE enabled,
synced it up, and the combined container — with `JOPLIN_MASTER_PASSWORD` set through the
new `${VAR:-default}` plumbing — then returned **`"title": ""`** from `list_notebooks`.
**Issue #29 reproduces on this stack today.** M1-T3 only has to codify it.

The next subtask **M1-T3 (e2ee-encrypted-titles-repro-test)** depends on this and on M1-T2.

## Non-goals

- No entrypoint changes (M1 is verification only).
- No CLI whitelist changes (`src/cli-executor.ts` — the combined container is not the path used for the seed; the seed container uses the same `joplin` binary as the combined container's entrypoint).
- No changes to `Dockerfile.combined` (M2-T3 changes it).
- No CI changes (M1-T5).
- No runner-script changes (M1-T4).
