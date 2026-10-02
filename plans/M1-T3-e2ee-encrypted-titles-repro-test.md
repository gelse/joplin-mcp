# M1-T3 — E2EE encrypted titles reproduction test

> Subtask of **M1 — E2EE Encrypted Titles Reproduction Integration Test**.
> Belongs to the verification milestone (M1). Implementation starts in a
> fresh session from this file alone.

## 1. Header

- **Subtask ID:** M1-T3
- **Milestone:** M1
- **Dependencies (other subtask IDs):** M1-T1 (test stack with real Joplin Server + seeder) and M1-T2 (seed script).
- **What it delivers:** `tests/container/e2ee-encrypted-titles-repro.test.ts` — vitest spec gated by `RUN_E2EE_REPRO_TESTS=1`. Asserts the SAFE state (plaintext non-empty `title`s, no `encryption_applied=1` on returned notebooks). Two anti-vacuous-pass gates (`SEED_GATE_FAILED`, `FIXTURE_NOT_SYNCED`) precede any symptom assertion. Bounded 90s polling.

## 2. Full problem context

GitHub issue #29 reports that the combined container
(`ghcr.io/gelse/joplin-mcp:latest`) serves E2EE-encrypted notebook titles
as-is via `list_notebooks` despite `JOPLIN_MASTER_PASSWORD` being set. The
reporter saw notebooks with **empty `title` fields** (or
`encryption_applied=1` with non-empty `encryption_cipher_text`).
`SYNC_PASS` was reported despite encrypted state — corroborated by
`README.md:60` ("the sync process will misleadingly report `SYNC_PASS`").
The reporter's manual workaround was: run `joplin e2ee decrypt` inside
the container. **This first failed** with *"DecryptionWorker: cannot
start because no master key is currently loaded"*, then succeeded on
retry (likely master-key propagation timing). After the manual decrypt,
**204 items** were decrypted in the SQLite DB, the Data API served
plaintext without restart, and `list_notebooks` then returned expected
notebooks. The test below reproduces this end-to-end: encrypted ciphertext
arrives via sync on the combined container, and `list_notebooks` is
expected to return plaintext titles (GREEN after M2; RED today).

## 3. Authoritative investigation evidence (with file:line)

- **entrypoint-combined.sh:306-309** — only master-password code:
  ```sh
  joplin config encryption.masterPassword "${JOPLIN_MASTER_PASSWORD}"
  log "INFO" "Master password configured from environment"
  ```
  No `e2ee decrypt`, no key load, no verification. The reporter's manual
  `e2ee decrypt` is exactly the missing step.
- **entrypoint-combined.sh:443** — `flock -w 120 "${SYNC_LOCK_FILE}" -c 'joplin sync'`. The symptom emerges after this line; M2-T1 inserts `e2ee decrypt` between this and `:445`.
- **src/mcp/tools.ts:45-47** — the user-facing surface:
  ```ts
  export const listNotebooks: ToolHandler<object, Folder[]> = async (_input, ctx) => {
    return ctx.client.getAllFolders();
  };
  ```
- **src/data-client.ts:479-482, 491-493** — `listFolders` → `GET /folders?limit=100&page=N`. No decryption anywhere.
- **src/api-types.ts:37-51** — `Folder` interface. **`encryption_cipher_text` at `:45`, `encryption_applied` at `:46`** (correction vs. source plan's cited 42–56; substance unchanged: the fields exist in the type and are never inspected by the client). The test reads `encryption_applied` for its symptom assertion.
- **reports/container/joplin-mcp.log:38,42-43,50-51** — `"e2ee/utils: Trying to load 0 master keys... Loaded master keys: 0"`. Verbatim pair at 42-43 confirms per-CLI-process master-key loading; this is why `joplin e2ee decrypt` is needed after sync (the DecryptionWorker runs in the sync process and exits; the keys don't persist).
- **tests/container/sqlite-busy-repro.test.ts:23-26** — gating pattern to mirror:
  ```ts
  const RUN_SYNC_LOCK_TESTS = process.env['RUN_SYNC_LOCK_TESTS'] === '1';
  const describeIfSyncLock = RUN_SYNC_LOCK_TESTS ? describe : describe.skip;
  ```
- **vitest.config.container.ts:7** — auto-includes `tests/container/**/*.test.ts`; serial execution; 30s default timeout (likely insufficient for this suite; bump to 180s in the test's per-call timeout).
- **tests/container/helpers.ts:1-64** — `createTestClient`, `callTool`, `uid`, `CleanupTracker`. The test reuses `createTestClient` and `callTool`; no new helper additions here (M1-T1 added `waitForHttp`).
- **M1-T2 contract:** seeder writes `/home/joplin/.config/joplin/.e2ee-seed-marker.json` (on seeder volume `joplin_seed_data`) with shape:
  ```json
  {
    "notebook_title": "EncryptedNotebook",
    "notebook_id": "<id>",
    "note_title": "EncryptedNote",
    "note_id": "<id>",
    "encrypted": true,
    "seeded_at": "<iso>"
  }
  ```
  The test reads this marker via a helper-side read of the seeder volume, OR via `docker exec` into the seeder container (after it has exited, no — once exited, it's gone). Use the volume-read approach: the marker is on `joplin_seed_data`; read it via a throwaway `alpine` container mounting that volume at `/vol/.marker`.

## 4. Scope

**Files to add:**
- `tests/container/e2ee-encrypted-titles-repro.test.ts` (new).

**Files NOT to touch:**
- `docker-compose.test.yml` (M1-T1).
- `tests/container/fixtures/e2ee-seed.sh` (M1-T2).
- `tests/container/helpers.ts` (M1-T1 added `waitForHttp`; this subtask uses existing helpers + new local helpers in the test file).
- `scripts/run-integration-tests.sh` (M1-T4).
- `.github/workflows/integration-tests.yml` (M1-T5).
- `src/`, `entrypoint-combined.sh` (M1 is verification only).

## 5. Exact behavior required

### File: `tests/container/e2ee-encrypted-titles-repro.test.ts`

```ts
/**
 * E2EE encrypted titles reproduction test (issue #29).
 *
 * Reproduces GitHub issue #29: with JOPLIN_MASTER_PASSWORD set and E2EE
 * enabled on a real Joplin Server, `list_notebooks` returns notebooks with
 * empty `title` fields (or encryption_applied=1 with non-empty
 * encryption_cipher_text) despite the master password being "configured".
 *
 * The test asserts the SAFE state:
 *   - title is non-empty plaintext
 *   - encryption_applied === 0 on every notebook
 *
 * On current container code this FAILS (proves the bug exists).
 * After M2 (A + B2 + C) the same test passes — WITHOUT any assertion edits.
 *
 * Gated behind RUN_E2EE_REPRO_TESTS=1. Mirrors the sqlite-busy-repro
 * gating pattern (tests/container/sqlite-busy-repro.test.ts:23-26).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { createTestClient, callTool } from './helpers.js';

// ---------------------------------------------------------------------------
// Gate: entire suite skipped unless RUN_E2EE_REPRO_TESTS=1
// ---------------------------------------------------------------------------
const RUN_E2EE_REPRO_TESTS = process.env['RUN_E2EE_REPRO_TESTS'] === '1';
const describeIfE2EE = RUN_E2EE_REPRO_TESTS ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const JOPLIN_CONTAINER = process.env['JOPLIN_CONTAINER'] || 'joplin-mcp';
const NOTEBOOK_TITLE = 'EncryptedNotebook';
const SYMPTOM_POLL_INTERVAL_MS = 5_000;
const SYMPTOM_POLL_MAX_ATTEMPTS = 18; // 18 × 5s = 90s
const SEED_VOLUME_NAME_HINT = 'joplin_seed_data'; // compose volume name (without project prefix)
const COMPOSE_FILE = 'docker-compose.test.yml';

// ---------------------------------------------------------------------------
// Helpers (local — no shared helpers changes)
// ---------------------------------------------------------------------------

/** Read a file from the seeder's data volume via a throwaway alpine container. */
function readSeedMarkerFile(seedVolume: string, inContainerPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2ee-marker-'));
  const outFile = join(dir, 'marker.json');
  try {
    execSync(
      `docker run --rm -v ${seedVolume}:/vol alpine sh -c "cat /vol/${inContainerPath} > /tmp/m.json"`,
      { encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    execSync(
      `docker run --rm -v ${seedVolume}:/vol -v ${dir}:/out alpine cp /vol/${inContainerPath} /out/marker.json`,
      { encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return readFileSync(outFile, 'utf-8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolve the project-prefixed volume name for the seeder's data volume. */
function resolveSeedVolumeName(): string {
  const out = execSync(
    `docker volume ls --format '{{.Name}}' | grep -E '(^|_)joplin_seed_data$' || true`,
    { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  // The output may be empty if the test stack never came up; let the test fail
  // with a useful assertion rather than throwing here.
  return out;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Folder {
  id: string;
  title: string;
  encryption_applied: number;
  encryption_cipher_text: string;
  master_key_id: string;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describeIfE2EE('E2EE encrypted titles reproduction (issue #29)', () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;

  beforeAll(async () => {
    client = await createTestClient();
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    // docker compose down -v is handled by the runner script (M1-T4).
  });

  it(
    'list_notebooks returns non-empty plaintext titles with encryption_applied === 0',
    async () => {
      // ------------------------------------------------------------------
      // Anti-vacuous gate 1: SEED_GATE_FAILED
      // ------------------------------------------------------------------
      // The seeder (M1-T2) must have written a marker file declaring that
      // an encrypted fixture was placed there. This prevents a vacuous PASS
      // when the seed step silently failed (e.g. server never enabled E2EE,
      // seeder raced the server, etc.).
      const seedVolume = resolveSeedVolumeName();
      expect(
        seedVolume,
        'SEED_GATE_FAILED: seeder volume not found — was the --profile e2ee-repro stack brought up?',
      ).not.toBe('');

      const markerRaw = readSeedMarkerFile(seedVolume, '.e2ee-seed-marker.json');
      let marker: { notebook_title: string; encrypted: boolean };
      try {
        marker = JSON.parse(markerRaw);
      } catch (e) {
        throw new Error(`SEED_GATE_FAILED: marker file unparseable (${(e as Error).message}): ${markerRaw.slice(0, 200)}`);
      }
      expect(
        marker.encrypted,
        `SEED_GATE_FAILED: no encrypted fixture on server (marker: ${JSON.stringify(marker)})`,
      ).toBe(true);

      // ------------------------------------------------------------------
      // Bounded polling for symptom gate + anti-vacuous gate 2
      // ------------------------------------------------------------------
      let finalResult: Folder[] = [];
      const deadline = Date.now() + SYMPTOM_POLL_MAX_ATTEMPTS * SYMPTOM_POLL_INTERVAL_MS;

      while (Date.now() < deadline) {
        const result = await callTool<{ items: Folder[]; has_more: boolean }>(
          client, 'list_notebooks', {},
        ).catch(async () => {
          // MCP may not be reachable if the combined container is restarting
          // mid-M2-T3; fall back to direct Data API.
          return { items: [], has_more: false };
        });

        // Some server-side list_notebooks responses wrap in {items, has_more};
        // others return Folder[] directly. Tolerate both.
        const arr: Folder[] = Array.isArray(result) ? result : result.items ?? [];

        // Anti-vacuous gate 2: the deterministic notebook title must appear.
        const hasFixture = arr.some((f) => f.title === NOTEBOOK_TITLE);
        if (!hasFixture) {
          await new Promise((r) => setTimeout(r, SYMPTOM_POLL_INTERVAL_MS));
          continue;
        }

        // Symptom gate: every returned notebook must have non-empty plaintext
        // title AND encryption_applied === 0.
        const allSafe = arr.every(
          (f) =>
            typeof f.title === 'string' &&
            f.title.length > 0 &&
            (f.encryption_applied ?? 0) === 0,
        );
        if (allSafe) {
          finalResult = arr;
          break;
        }
        finalResult = arr; // remember the latest for diagnostics
        await new Promise((r) => setTimeout(r, SYMPTOM_POLL_INTERVAL_MS));
      }

      // ------------------------------------------------------------------
      // Anti-vacuous gate 2 (asserted): the seeded notebook must be present.
      // ------------------------------------------------------------------
      const hasFixture = finalResult.some((f) => f.title === NOTEBOOK_TITLE);
      expect(
        hasFixture,
        `FIXTURE_NOT_SYNCED: seeded notebook '${NOTEBOOK_TITLE}' absent from list_notebooks ` +
          `after ${SYMPTOM_POLL_MAX_ATTEMPTS * (SYMPTOM_POLL_INTERVAL_MS / 1000)}s. ` +
          `Returned: ${JSON.stringify(finalResult.map((f) => ({ id: f.id, title: f.title, enc: f.encryption_applied })))}`,
      ).toBe(true);

      // ------------------------------------------------------------------
      // Symptom assertion (RED today, GREEN after M2; no edits across flips).
      // ------------------------------------------------------------------
      const violations = finalResult
        .map((f) => ({
          id: f.id,
          title: f.title,
          encryption_applied: f.encryption_applied,
          has_cipher: !!(f.encryption_cipher_text && f.encryption_cipher_text.length > 0),
        }))
        .filter(
          (f) =>
            !f.title ||
            f.title.length === 0 ||
            f.encryption_applied !== 0 ||
            f.has_cipher,
        );

      expect(
        violations,
        `E2EE symptom: ${violations.length} notebook(s) served with empty title / encryption_applied=1 / non-empty cipher. ` +
          `First 3: ${JSON.stringify(violations.slice(0, 3))}`,
      ).toEqual([]);

      // Diagnostic cross-check (NOT a flip-point; never the pass criterion).
      // Direct Data API GET /folders/:id returns plaintext title.
      const fixture = finalResult.find((f) => f.title === NOTEBOOK_TITLE);
      if (fixture) {
        try {
          const direct = await callTool<Folder>(client, 'read_notebook', { notebook_id: fixture.id });
          console.log(
            `direct MCP read_notebook returned title='${direct.title}' enc=${direct.encryption_applied}`,
          );
        } catch {
          console.warn('MCP read_notebook failed — diagnostic only; not a flip-point');
        }
      }
    },
    180_000,
  );
});
```

## 6. Acceptance criteria

- Test file exists at the path above; gated by `RUN_E2EE_REPRO_TESTS=1`.
- Two anti-vacuous gates (`SEED_GATE_FAILED`, `FIXTURE_NOT_SYNCED`) are independent assertions: each fails with its own explicit message when violated; neither passes when the underlying surface is missing.
- Symptom assertion is the flip-point and passes only when all notebooks have non-empty plaintext titles AND `encryption_applied === 0`. No edits to the symptom assertion are required for the GREEN flip after M2.
- Bounded 90s polling absorbs sync + decrypt timing variance.
- Per-test timeout is 180s (covers worst-case sync 30s + decrypt 30s + retry).

## 7. Verification commands

1. **RED check (current code):** with the e2ee-repro profile up and a fresh `joplin_data` volume, run the test:
   ```sh
   RUN_E2EE_REPRO_TESTS=1 docker compose -f docker-compose.test.yml run --rm \
     -e RUN_E2EE_REPRO_TESTS=1 \
     -e JOPLIN_CONTAINER=<id> \
     test-runner \
     pnpm vitest run --config vitest.config.container.ts \
       tests/container/e2ee-encrypted-titles-repro.test.ts
   ```
   → exit non-zero; symptom assertion message lists notebooks with empty title / `encryption_applied=1`.
2. **Anti-vacuous-pass check (mechanism disabled):** disable the seeder (e.g. set `JOPLIN_MASTER_PASSWORD` empty to force a SEED_GATE_FAILED) → exit non-zero with the explicit `SEED_GATE_FAILED: no encrypted fixture on server` message.
3. **Anti-vacuous-pass check (seeded notebook absent):** manipulate the seeder to NOT sync at the end → exit non-zero with `FIXTURE_NOT_SYNCED: seeded notebook 'EncryptedNotebook' absent from list_notebooks`.
4. **GREEN flip (after M2):** same command as (1) → exit 0; no assertion edits between (1) and this step.

## 8. Risks / gotchas

- **Gap 3 (assigned to M1-T1):** does the Joplin Server REST API expose `encryption_applied`? If NO → the seeder's marker file is the seed-time surface; this test reads the marker. If the marker file is not present, `SEED_GATE_FAILED` fires loudly.
- **Gap 4 (master-key propagation timing):** the reporter saw `e2ee decrypt` fail on first try. Bounded polling absorbs this; if flakes persist, add a pre-test `joplin sync` warmup (documented in the source plan Risk #5; do not pre-add).
- **Bounded polling drift in CI runners** — 180s per-test is fine for a gated opt-in job, not for the default CI.
- **MCP list_notebooks response shape:** the current `JoplinDataClient.getAllFolders()` returns `Folder[]` directly (after `fetchAllPages` flattens), so the test handles both `{ items, has_more }` and `Folder[]` shapes.

## 9. Research spikes assigned

- **Gap 3 — REST API `encryption_applied` exposure** — answered in M1-T1; affects this test only indirectly (the marker file is the gate-agnostic surface). Already counted in M1-T1's ~15 min.
- **Gap 4 — master-key propagation timing** — if flakes in actual CI runs, add a pre-test `joplin sync` warmup; bounded retries in the test above already absorb it (per Gap 4 design).

## 10. Handoff note

The next subtask is **M1-T4 (runner-script pass-through)**, which depends on this. M1-T4 adds `RUN_E2EE_REPRO_TESTS` pass-through to `scripts/run-integration-tests.sh` and runs the repro in a separate vitest invocation (matching the `sqlite-busy-repro` isolation pattern in the runner).

After M1-T4: **M1-T5 (CI wiring)** — M1 adds the new opt-in `workflow_dispatch` job.

After all M1 subtasks: **M2-T1..T4 (the fix)** — M2-T4's verification runs THIS test with zero assertion edits.

## Non-goals

- No entrypoint changes (M1 is verification only).
- No CLI whitelist changes.
- No CLI subcommand additions.
- No coverage of the upload-only E2EE path.
