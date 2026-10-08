# M1-T2 — E2EE seed fixture script

> **Filing note (2026-10-04):** moved verbatim from `plans/M1-T2-e2ee-seed-fixture-script.md`
> to `plans/_finished/M1-T2-e2ee-seed-fixture-script.md` in the finished-milestone
> filing batch. **Finished:** delivered — `tests/container/fixtures/e2ee-seed.sh` exists
> in the repo and ran as the `joplin-e2ee-seed` one-shot service (exit 0) in the
> verified M1-T1 proof stack.

> Subtask of **M1 — E2EE Encrypted Titles Reproduction Integration Test**.
> Belongs to the verification milestone (M1). Implementation starts in a
> fresh session from this file alone.

## 1. Header

- **Subtask ID:** M1-T2
- **Milestone:** M1
- **Dependencies (other subtask IDs):** M1-T1 (the seed container that runs this script depends on the compose changes in M1-T1).
- **What it delivers:** `tests/container/fixtures/e2ee-seed.sh` — a bash script using the `joplin` CLI against the same Joplin Server the combined container will sync against. Creates a deterministic encrypted notebook + note on the server, then exits 0. Idempotent.

## 2. Full problem context

GitHub issue #29 reports the combined container serves E2EE-encrypted
notebook titles as-is via `list_notebooks`. The reporter saw empty
`title` fields (or `encryption_applied=1` with non-empty
`encryption_cipher_text`), `SYNC_PASS` despite encrypted state (corroborated
by `README.md:60` — "the sync process will misleadingly report
`SYNC_PASS`"), and a manual `joplin e2ee decrypt` that first failed
("DecryptionWorker: cannot start because no master key is currently
loaded") before succeeding — 204 items decrypted, then plaintext served
without server restart. **The reproducer must place encrypted items on
the server before the combined container syncs**, mirroring the reporter's
end-to-end path. This is the seeder's job: idempotently create one
encrypted notebook + one encrypted note on the server, push them via
`joplin sync`, then exit 0 so the combined container can start.

## 3. Authoritative investigation evidence (with file:line)

- **entrypoint-combined.sh:294-297** — `sync.target` config syntax; the seed script configures its own sync target against the test server. Format:
  ```sh
  joplin config sync.target 10
  joplin config "sync.10.path" "${JOPLIN_SERVER_URL}"
  joplin config "sync.10.username" "${JOPLIN_USERNAME}"
  joplin config "sync.10.password" "${JOPLIN_PASSWORD}"
  ```
- **entrypoint-combined.sh:306-309** — master-password config (mirrors what the combined container does):
  ```sh
  joplin config encryption.masterPassword "${JOPLIN_MASTER_PASSWORD}"
  ```
- **Joplin CLI 3.7.1 (pinned in Dockerfile.combined:44)** — available subcommands for notebook/note creation (the seed script uses these; this is NOT the same whitelist as `src/cli-executor.ts` because the entrypoint uses the global `joplin` binary):
  - `mkbook <title>` — create a notebook
  - `use <notebook>` — select the active notebook
  - `mknote <title>` — create a note in the active notebook
  - `set <id> <field> <value>` — set a field on an item (e.g. `body`)
  - `ls -l` — list items in long form; encrypted items have `[Encrypted]` markers (per spike below)
  - `sync` — sync with configured target
  - `config` — get/set config keys
- **reports/container/joplin-mcp.log:38,42-43,50-51** — per-CLI-process master-key loading. The seed script's `joplin sync` call must run AFTER `joplin config encryption.masterPassword` is set in the SAME `joplin` invocation's profile (the seed container's `/home/joplin/.config/joplin`), so the master key is loaded before sync.
- **Dockerfile.combined:44** — `JOPLIN_CLI_VERSION=3.7.1`. The seed container reuses this exact version (M1-T1 mounts the `joplin-mcp-combined:test` image, so the version matches).

## 4. Scope

**Files to add:**
- `tests/container/fixtures/e2ee-seed.sh` (new; bash + `joplin` CLI).

**Files NOT to touch:**
- `docker-compose.test.yml` (M1-T1 already mounts the script at `/seed.sh`).
- `entrypoint-combined.sh` (M1 is verification only).
- Any source code in `src/`.

## 5. Exact behavior required

`tests/container/fixtures/e2ee-seed.sh`:

```sh
#!/bin/bash
# Seed script — runs in a one-shot container against the test Joplin Server.
# Creates a deterministic encrypted notebook + note, syncs them to the server,
# and exits 0 so the combined container can start.

set -euo pipefail

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] [seed] $*" >&2; }

: "${JOPLIN_SERVER_URL:?JOPLIN_SERVER_URL must be set}"
: "${JOPLIN_USERNAME:?JOPLIN_USERNAME must be set}"
: "${JOPLIN_PASSWORD:?JOPLIN_PASSWORD must be set}"
: "${JOPLIN_MASTER_PASSWORD:?JOPLIN_MASTER_PASSWORD must be set}"

NOTEBOOK_TITLE="EncryptedNotebook"
NOTE_TITLE="EncryptedNote"

log "Configuring sync target: ${JOPLIN_SERVER_URL}"
joplin config sync.target 10
joplin config "sync.10.path" "${JOPLIN_SERVER_URL}"
joplin config "sync.10.username" "${JOPLIN_USERNAME}"
joplin config "sync.10.password" "${JOPLIN_PASSWORD}"

log "Setting master password"
joplin config encryption.masterPassword "${JOPLIN_MASTER_PASSWORD}"

log "Performing initial sync against server (may download or no-op)"
joplin sync || { log "Initial seed sync failed — aborting"; exit 1; }

# Idempotency: if the notebook already exists (re-run), skip creation.
EXISTING=$(joplin ls -l / 2>/dev/null | awk -v t="${NOTEBOOK_TITLE}" '$0 ~ t {print $1; exit}')
if [ -z "${EXISTING:-}" ]; then
  log "Creating notebook: ${NOTEBOOK_TITLE}"
  joplin mkbook "${NOTEBOOK_TITLE}"
else
  log "Notebook already exists: id=${EXISTING}"
fi

log "Selecting notebook: ${NOTEBOOK_TITLE}"
joplin use "${NOTEBOOK_TITLE}"

EXISTING_NOTE=$(joplin ls -l 2>/dev/null | awk -v t="${NOTE_TITLE}" '$0 ~ t {print $1; exit}')
if [ -z "${EXISTING_NOTE:-}" ]; then
  log "Creating note: ${NOTE_TITLE}"
  joplin mknote "${NOTE_TITLE}"
  NOTE_ID=$(joplin ls -l 2>/dev/null | awk -v t="${NOTE_TITLE}" '$0 ~ t {print $1; exit}')
else
  log "Note already exists: id=${EXISTING_NOTE}"
  NOTE_ID="${EXISTING_NOTE}"
fi

log "Setting note body (forcibly marks the note encrypted on next sync)"
joplin set "${NOTE_ID}" body "secret-content-${NOTE_TITLE}"

# Bounded wait for master-key propagation: the reporter saw the first
# `joplin e2ee decrypt` fail because of this; our flow is unaffected
# (we set the master password BEFORE the first sync), but a short settle
# avoids race when the test server has just started.
log "Settling 2s for master-key propagation"
sleep 2

log "Syncing to push ciphertext to server"
joplin sync || { log "Seed final sync failed — aborting"; exit 1; }

# Write a seed-time marker file for M1-T3's mechanism-validation gate.
# This is the escape hatch when the Joplin Server REST API does NOT expose
# encryption_applied (Gap 3 — assigned to M1-T1).
MARKER_DIR="${HOME}/.config/joplin"
mkdir -p "${MARKER_DIR}"
NOTEBOOK_ID=$(joplin ls -l / 2>/dev/null | awk -v t="${NOTEBOOK_TITLE}" '$0 ~ t {print $1; exit}')
cat > "${MARKER_DIR}/.e2ee-seed-marker.json" <<EOF
{
  "notebook_title": "${NOTEBOOK_TITLE}",
  "notebook_id": "${NOTEBOOK_ID}",
  "note_title": "${NOTE_TITLE}",
  "note_id": "${NOTE_ID}",
  "encrypted": true,
  "seeded_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}
EOF
log "Marker written: ${MARKER_DIR}/.e2ee-seed-marker.json"

log "Seed complete; exiting 0"
exit 0
```

**Failure modes handled:**
- Missing required env vars → script exits 1 before any side effects.
- First `joplin sync` failure → script exits 1 (server may not be ready; M1-T1's `depends_on: joplin-server: condition: service_healthy` should prevent this, but defensive exit is correct).
- Final `joplin sync` failure → script exits 1 (ciphertext didn't reach the server; M1-T3's gate would fail with `SEED_GATE_FAILED`).
- `set -euo pipefail` ensures any unexpected error aborts.

## 6. Acceptance criteria

- Script is executable (`chmod +x tests/container/fixtures/e2ee-seed.sh`).
- Idempotent: re-running on a server that already has the fixture skips creation and reaches the same final state (sync 0 items if all current, or sync updates if anything changed).
- Deterministic: `NOTEBOOK_TITLE=EncryptedNotebook`, `NOTE_TITLE=EncryptedNote` (literal strings, no timestamps).
- On a clean server, exit 0 within 30s (initial sync typically < 5s on a fresh profile, plus 2s settle + final sync).
- Marker file written to `${HOME}/.config/joplin/.e2ee-seed-marker.json` containing the JSON above.

## 7. Verification commands

1. Manual (against a local test server):
   ```sh
   docker run --rm --network host \
     -e JOPLIN_SERVER_URL=http://localhost:22300 \
     -e JOPLIN_USERNAME=test-user \
     -e JOPLIN_PASSWORD=test-password \
     -e JOPLIN_MASTER_PASSWORD=test-password \
     -v "$PWD/tests/container/fixtures/e2ee-seed.sh:/seed.sh:ro" \
     joplin-mcp-combined:test bash /seed.sh
   ```
   → exit 0; marker file path printed.
2. Re-run the same command → exit 0; logs `Notebook already exists: id=…` and `Note already exists: id=…`.
3. Via the compose profile (after M1-T1 + M1-T4 land):
   ```sh
   docker compose -f docker-compose.test.yml --profile e2ee-repro up joplin-e2ee-seed
   ```
   → `joplin-e2ee-seed` exits 0; `docker compose ps` shows only `joplin-server` and `test-runner` still up.

## 8. Risks / gotchas

- **E2EE is enabled by the seeder itself** (correction of the original assumption, which claimed `joplin e2ee enable` is interactive and that the test server has E2EE enabled out-of-band — both false on the pinned CLI 3.7.1: `joplin e2ee enable -p <password> -f` does not prompt, exits 0, and is a safe no-op on re-runs; verified against `joplin-mcp-combined:test`). A configured master password alone does NOT activate encryption, so the seeder calls `joplin e2ee enable -p "${JOPLIN_MASTER_PASSWORD}" -f` BEFORE creating any item, making the fixture sync as ciphertext. If enabling fails, the seeder aborts non-zero without writing a passing marker (loud failure, never a silently unencrypted seed), and a post-sync verification re-checks server-side ciphertext before the marker is written.
- **`joplin mknote` body flag:** CLI 3.7.1's `mknote` accepts `--body` to set the body inline; this script instead creates the note then uses `joplin set <id> body …` (matches the source plan's snippet). Both work; `set` is robust against title-only `mknote` invocations.
- **`joplin ls -l .` is a no-op path pattern in CLI 3.7.1:** after `joplin use <notebook>`, listing the current notebook with `joplin ls -l .` returns empty output with exit 0 instead of listing notes. The seed script's note-id lookups therefore use no-arg `joplin ls -l` (the notebook lookups use `joplin ls -l /`, the documented root pattern, and are unaffected). The JSON form `joplin ls --format=json` mentioned in the brittleness escape hatch below would also sidestep this gotcha by parsing the same data without relying on a path argument.
- **`joplin ls -l` parser brittleness:** the `awk` parser relies on the title appearing somewhere in the line. Encrypted items in `ls -l` output carry a `[Encrypted]` marker after the id; the title follows. If the format changes, the parser silently returns empty, and the script creates a duplicate (defeats idempotency). **Escape hatch:** parse the JSON output of `joplin ls --format=json` instead of `ls -l`. Use `joplin ls -l` for the current repo state, but **note** in the code that `joplin ls --format=json` is the long-term form.

## 9. Research spikes assigned

- (None directly assigned to M1-T2 — the master-key-propagation-timing spike is shared with M1-T3 / M2-T1; the `joplin ls -l` parser brittleness is documented above as an escape hatch but no formal spike.)

## 10. Handoff note

The next subtask in the sequence is **M1-T3 (e2ee-encrypted-titles-repro-test)**, which depends on this and on M1-T1. M1-T3 reads the marker file the seeder writes (`${HOME}/.config/joplin/.e2ee-seed-marker.json` on the seeder's volume — note this is the seeder's volume, NOT the combined container's; the marker is NOT transferred to the combined container, only used as seed-time evidence). M1-T3's mechanism-validation gate (defined there) reads the marker via `docker compose run` exec'ing into the `joplin-e2ee-seed` container, OR via the helper container reading the seeder's volume (which is `joplin_seed_data` per M1-T1's volumes block).

The seeder's marker file shape is the contract between M1-T2 and M1-T3 — do not change `notebook_title`, `note_title`, or `encrypted` field names without coordinating.

## Non-goals

- No CLI subcommand additions (the existing CLI commands are sufficient).
- No upload-side testing (reporter's bug is about *download*).
- No encryption-state probing via the Joplin Server REST API (Gap 3 — that work belongs to M1-T3, not the seeder).
