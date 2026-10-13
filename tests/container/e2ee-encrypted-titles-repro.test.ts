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
// JOPLIN_CONTAINER and COMPOSE_FILE are retained verbatim from the milestone
// spec (M1-T3 §5) for env-contract visibility; this test drives everything
// through MCP and docker volumes, so it never execs into that container.
const JOPLIN_CONTAINER = process.env['JOPLIN_CONTAINER'] || 'joplin-mcp';
const NOTEBOOK_TITLE = 'EncryptedNotebook';
const SYMPTOM_POLL_INTERVAL_MS = 5_000;
const SYMPTOM_POLL_MAX_ATTEMPTS = 18; // 18 × 5s = 90s
const SEED_VOLUME_NAME_HINT = 'joplin_seed_data'; // compose volume name (without project prefix)
const COMPOSE_FILE = 'docker-compose.test.yml';

// ---------------------------------------------------------------------------
// Helpers (local — no shared helpers changes)
// ---------------------------------------------------------------------------

/**
 * Read a file from the seeder's data volume into a caller-local temp dir.
 *
 * A throwaway alpine container exposes the file, and `docker cp` pulls it
 * into the CALLER's filesystem: `docker cp` resolves its destination in the
 * CLI process's own namespace, so this works both on the host and inside the
 * test-runner container (§7.1). A plain `docker run -v <tmpdir>:/out` bind
 * would instead be resolved by the daemon on the HOST — the copy would land
 * outside the caller's view and `readFileSync` would fail with ENOENT.
 * The temp dir is removed in `finally`.
 */
function readSeedMarkerFile(seedVolume: string, inContainerPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2ee-marker-'));
  const outFile = join(dir, 'marker.json');
  const readerName = `e2ee-marker-reader-${Date.now()}`;
  try {
    execSync(
      `docker create --name ${readerName} -v ${seedVolume}:/vol alpine true`,
      { encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    execSync(
      `docker cp ${readerName}:/vol/${inContainerPath} ${outFile}`,
      { encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return readFileSync(outFile, 'utf-8');
  } finally {
    try {
      execSync(`docker rm -f ${readerName}`, {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      /* best-effort cleanup */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Resolve the project-prefixed volume name for the seeder's data volume.
 *
 * `docker volume ls` output is matched against the compose volume name and
 * reduced to a SINGLE deterministic name (docker may list both the bare
 * `joplin_seed_data` and `<project>_joplin_seed_data`; interpolating more
 * than one line into `-v <name>:/vol` would be invalid). The exact
 * unprefixed name wins if present, else the first match. An empty result
 * means the e2ee-repro stack never came up; the caller's SEED_GATE_FAILED
 * assertion turns that into a useful failure instead of a throw here.
 */
function resolveSeedVolumeName(): string {
  const out = execSync(
    `docker volume ls --format '{{.Name}}' | grep -E '(^|_)${SEED_VOLUME_NAME_HINT}$' || true`,
    { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const names = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (names.length === 0) return '';
  return names.includes(SEED_VOLUME_NAME_HINT) ? SEED_VOLUME_NAME_HINT : names[0];
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

      const markerRaw = (() => {
        try {
          return readSeedMarkerFile(seedVolume, '.e2ee-seed-marker.json');
        } catch (e) {
          throw new Error(
            `SEED_GATE_FAILED: marker file '.e2ee-seed-marker.json' not readable on volume '${seedVolume}' — ` +
              `the seed step may not have run (${(e as Error).message})`,
          );
        }
      })();
      let marker: { notebook_title: string; notebook_id: string; encrypted: boolean };
      try {
        marker = JSON.parse(markerRaw);
      } catch (e) {
        throw new Error(`SEED_GATE_FAILED: marker file unparseable (${(e as Error).message}): ${markerRaw.slice(0, 200)}`);
      }
      // The seeder's awk-based id parse can yield an empty notebook_id; that
      // is a seed defect and must fail LOUDLY here (gate 1), never silently
      // degrade gate 2 into a title match or a confusing FIXTURE_NOT_SYNCED.
      if (typeof marker.notebook_id !== 'string' || marker.notebook_id.length === 0) {
        throw new Error(
          `SEED_GATE_FAILED: marker malformed (empty notebook_id); marker: ${JSON.stringify(marker)}`,
        );
      }
      expect(
        marker.encrypted,
        `SEED_GATE_FAILED: no encrypted fixture on server (marker: ${JSON.stringify(marker)})`,
      ).toBe(true);

      // ------------------------------------------------------------------
      // Bounded polling for symptom gate + anti-vacuous gate 2
      // ------------------------------------------------------------------
      let finalResult: Folder[] = [];
      // Holder object (not a bare let) so the catch callback can record the
      // last MCP failure for the gate diagnostics below.
      const lastPollError = { message: '' };
      const deadline = Date.now() + SYMPTOM_POLL_MAX_ATTEMPTS * SYMPTOM_POLL_INTERVAL_MS;

      while (Date.now() < deadline) {
        const result = await callTool<{ items: Folder[]; has_more: boolean }>(
          client, 'list_notebooks', {},
        ).catch((err: unknown) => {
          // MCP may be temporarily unreachable (e.g. the combined container
          // restarting mid-M2-T3); keep polling within the bounded window and
          // remember the failure so the FIXTURE_NOT_SYNCED message can show
          // why list_notebooks kept returning nothing.
          lastPollError.message = err instanceof Error ? err.message : String(err);
          return { items: [] as Folder[], has_more: false };
        });

        // Some server-side list_notebooks responses wrap in {items, has_more};
        // others return Folder[] directly. Tolerate both.
        const arr: Folder[] = Array.isArray(result) ? result : result.items ?? [];

        // Anti-vacuous gate 2: the seeded notebook must appear, matched by
        // its stable id from the marker. Title matching cannot be used: in
        // the RED state the fixture's title is served as "" (issue #29), so
        // a title comparison could never identify the fixture.
        const hasFixture = arr.some((f) => f.id === marker.notebook_id);
        if (!hasFixture) {
          await new Promise((r) => setTimeout(r, SYMPTOM_POLL_INTERVAL_MS));
          continue;
        }

        // Loop predicate: absent-or-0 on encryption_applied (`?? 0`). It
        // only decides when to stop waiting; the authoritative flip-point
        // below applies the SAME absent-or-0 rule. The Data API's
        // GET /folders (exactly as list_notebooks issues it, no `fields=`)
        // never includes encryption_applied, so a strict `!== 0` on the raw
        // key would flag every response — safe ones included — forever.
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
      const hasFixture = finalResult.some((f) => f.id === marker.notebook_id);
      const lastErrorSuffix = lastPollError.message
        ? ` Last list_notebooks error: ${lastPollError.message}.`
        : '';
      expect(
        hasFixture,
        `FIXTURE_NOT_SYNCED: seeded notebook '${marker.notebook_id}' (title '${NOTEBOOK_TITLE}') absent from list_notebooks ` +
          `after ${SYMPTOM_POLL_MAX_ATTEMPTS * (SYMPTOM_POLL_INTERVAL_MS / 1000)}s.${lastErrorSuffix} ` +
          `Returned: ${JSON.stringify(finalResult.map((f) => ({ id: f.id, title: f.title, enc: f.encryption_applied })))}`,
      ).toBe(true);

      // ------------------------------------------------------------------
      // Symptom assertion (RED today, GREEN after M2; no edits across flips).
      //
      // has_cipher is part of the SAFE definition (issue #29 reports
      // encryption_applied=1 served WITH non-empty encryption_cipher_text).
      // It does not block the GREEN flip: Joplin clears
      // encryption_cipher_text when it decrypts an item, so a correctly
      // decrypted folder has encryption_applied=0, plaintext title AND empty
      // cipher text simultaneously (per issue #29, the post-decrypt Data API
      // served exactly that state). M2-T4 must re-confirm this against the
      // real post-fix API response.
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
            // absent-or-0 deviation (documented): GET /folders as issued by
            // list_notebooks (no `fields=`) omits encryption_applied for
            // every row — a strict `!== 0` would be permanently RED even on
            // genuinely decrypted, plaintext responses.
            (f.encryption_applied ?? 0) !== 0 ||
            f.has_cipher,
        );

      expect(
        violations,
        `E2EE symptom: ${violations.length} notebook(s) served with empty title / encryption_applied=1 / non-empty cipher. ` +
          `First 3: ${JSON.stringify(violations.slice(0, 3))}`,
      ).toEqual([]);

      // Diagnostic cross-check (NOT a flip-point; never the pass criterion).
      // Direct MCP read of the fixture notebook returns plaintext title.
      const fixture = finalResult.find((f) => f.id === marker.notebook_id);
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
