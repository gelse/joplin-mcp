/**
 * E2EE decrypt-on-resync reproduction test (issue #29, comment 6072403277).
 *
 * Reproduces the SECOND half of issue #29: the boot/initial-sync path
 * decrypts correctly (fixed by M2, merge 451845c), but notes added
 * remotely AFTER boot only reach the container through the PERIODIC sync
 * loop — which (pre-fix) never runs `joplin e2ee decrypt`. Such notes
 * arrive as ciphertext and stay encrypted until the operator manually
 * runs `joplin e2ee decrypt` in the container.
 *
 * Scenario (orchestrated by scripts/run-integration-tests.sh, e2ee branch):
 *   1. joplin-mcp boots against the seeded real server and decrypts the
 *      base fixture (the existing e2ee-encrypted-titles-repro proves that
 *      BEFORE this test runs).
 *   2. The runner re-runs the seeder with unique titles, creating a NEW
 *      encrypted notebook+note pair at the E2EE-enabled source client and
 *      pushing the ciphertext to the server AFTER boot. The seeder refuses
 *      to write its marker unless the pair is verified encrypted on the
 *      server (anti-vacuous: a plaintext-at-source fixture would arrive
 *      already decrypted and pass vacuously).
 *   3. THIS test polls ONLY the MCP surface until the pair is delivered
 *      AND decrypted by the periodic loop (SYNC_INTERVAL_SECONDS is
 *      shortened to ~20s by the runner for the recreated joplin-mcp).
 *
 * Critical reproduction rule: the test NEVER triggers sync itself — no
 * `docker exec ... joplin sync` (bypasses the loop; would fail even
 * post-fix) and no container restart (restart re-enters the boot path,
 * which already decrypts — would falsely pass pre-fix). The periodic loop
 * is the only delivery path exercised.
 *
 * Assertions (marker-driven, attribution-specific):
 *   - RESYNC_NOT_SYNCED: the pair never appeared via MCP within the
 *     polling window → periodic SYNC problem (harness/sync defect), not
 *     the decrypt defect.
 *   - RESYNC_STILL_ENCRYPTED: the pair appeared but its folder/note stayed
 *     encrypted (empty title / non-empty cipher) → the reported decrypt
 *     defect. This is the expected PRE-FIX failure.
 *   - BOOT_PRECONDITION_FAILED: the base fixture notebook is not decrypted
 *     at test start → boot-decrypt premise broken (covered in depth by the
 *     encrypted-titles repro; fatal here because the arrival signal relies
 *     on post-boot items being decrypted).
 *
 * Gated behind RUN_E2EE_REPRO_TESTS=1 (mirrors
 * tests/container/e2ee-encrypted-titles-repro.test.ts:30-31).
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
// Unique token the runner generated for THIS run's phase-2 fixtures. Set it
// in the marker-file cross-check below; direct vitest runs (no runner) fall
// back to the marker file contents, exactly like JOPLIN_CONTAINER does for
// the container id (integration-runner-config.test.ts invariant 4).
const RESYNC_MARKER_TOKEN = process.env['E2EE_RESYNC_MARKER'] || '';
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 24; // 24 × 5s = 120s ≫ one 20s interval + sync + decrypt
const SEED_VOLUME_NAME_HINT = 'joplin_seed_data'; // compose volume name (without project prefix)

// ---------------------------------------------------------------------------
// Helpers — local copies of the seed-volume readers from
// e2ee-encrypted-titles-repro.test.ts (deliberate: that file pins "no shared
// helpers changes"; keep the copies in lockstep with it).
// ---------------------------------------------------------------------------

/**
 * Read a file from the seeder's data volume into a caller-local temp dir
 * (docker create + docker cp; see the long rationale on the copy in
 * e2ee-encrypted-titles-repro.test.ts:50-87 — the volume is exposed via a
 * throwaway alpine container and `docker cp` resolves the destination in the
 * CALLER's namespace, which works inside the test-runner container).
 */
function readSeedMarkerFile(seedVolume: string, inContainerPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2ee-resync-marker-'));
  const outFile = join(dir, 'marker.json');
  const readerName = `e2ee-resync-marker-reader-${Date.now()}`;
  try {
    execSync(`docker create --name ${readerName} -v ${seedVolume}:/vol alpine true`, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execSync(`docker cp ${readerName}:/vol/${inContainerPath} ${outFile}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
 * Resolve the project-prefixed seeder volume name (see the long rationale on
 * the copy in e2ee-encrypted-titles-repro.test.ts:89-111). Empty result ⇒ the
 * e2ee-repro stack never came up; the SEED gate assertions below turn that
 * into a useful failure instead of a throw here.
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

interface SeedMarker {
  notebook_title: string;
  notebook_id: string;
  encrypted: boolean;
}

interface ResyncMarker {
  notebook_title: string;
  notebook_id: string;
  note_title: string;
  note_id: string;
  note_body: string;
  encrypted: boolean;
}

/** Full folder row as served by list_notebooks (no `fields=` filter). */
interface Folder {
  id: string;
  title: string;
  encryption_applied?: number;
  encryption_cipher_text?: string;
}

/** Page row as served by list_notes (fields-limited: no cipher fields). */
interface Note {
  id: string;
  title: string;
  body: string;
}

/**
 * Folder-level SAFE predicate — identical to the encrypted-titles repro's:
 * non-empty plaintext title, absent-or-0 encryption_applied (GET /folders
 * never includes the key), empty encryption_cipher_text (cleared on decrypt).
 */
function folderIsSafe(f: Folder, expectedTitle: string): boolean {
  return (
    typeof f.title === 'string' &&
    f.title === expectedTitle &&
    (f.encryption_applied ?? 0) === 0 &&
    !(f.encryption_cipher_text && f.encryption_cipher_text.length > 0)
  );
}

/** Note-level SAFE predicate: plaintext marker title AND restored marker body. */
function noteIsSafe(n: Note, expectedTitle: string, expectedBody: string): boolean {
  return n.title === expectedTitle && n.body === expectedBody;
}

function describeFolder(f: Folder | undefined): string {
  if (!f) return 'absent';
  return JSON.stringify({
    id: f.id,
    title: f.title,
    enc: f.encryption_applied,
    has_cipher: !!(f.encryption_cipher_text && f.encryption_cipher_text.length > 0),
  });
}

function describeNote(n: Note | undefined): string {
  if (!n) return 'absent';
  return JSON.stringify({
    id: n.id,
    title: n.title,
    body_matches_prefix: typeof n.body === 'string' && n.body.startsWith('secret-content-'),
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describeIfE2EE('E2EE decrypt-on-resync reproduction (issue #29 comment 6072403277)', () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;
  let seedMarker: SeedMarker;
  let resyncMarker: ResyncMarker;

  beforeAll(async () => {
    client = await createTestClient();

    // ------------------------------------------------------------------
    // SEED gates: both seeder markers must exist and be well-formed.
    // ------------------------------------------------------------------
    const seedVolume = resolveSeedVolumeName();
    expect(
      seedVolume,
      'SEED_GATE_FAILED: seeder volume not found — was the --profile e2ee-repro stack brought up?',
    ).not.toBe('');

    const readMarker = <T>(path: string, gate: string): T => {
      try {
        return JSON.parse(readSeedMarkerFile(seedVolume, path)) as T;
      } catch (e) {
        throw new Error(`${gate}: marker file '${path}' not readable on volume '${seedVolume}' — ${(e as Error).message}`);
      }
    };

    seedMarker = readMarker<SeedMarker>('.e2ee-seed-marker.json', 'SEED_GATE_FAILED');
    expect(
      seedMarker.encrypted,
      `SEED_GATE_FAILED: base fixture not encrypted on server (marker: ${JSON.stringify(seedMarker)})`,
    ).toBe(true);

    resyncMarker = readMarker<ResyncMarker>(
      '.e2ee-resync-marker.json',
      'RESYNC_SEED_GATE_FAILED',
    );
    if (
      typeof resyncMarker.notebook_id !== 'string' ||
      resyncMarker.notebook_id.length === 0 ||
      typeof resyncMarker.note_id !== 'string' ||
      resyncMarker.note_id.length === 0
    ) {
      throw new Error(
        `RESYNC_SEED_GATE_FAILED: resync marker malformed (empty ids); marker: ${JSON.stringify(resyncMarker)}`,
      );
    }
    expect(
      resyncMarker.encrypted,
      `RESYNC_SEED_GATE_FAILED: phase-2 fixtures NOT verified encrypted on the server — the resync repro ` +
        `would pass vacuously on an already-plaintext fixture (marker: ${JSON.stringify(resyncMarker)})`,
    ).toBe(true);
    // Anti-stale-marker: the marker must belong to THIS runner invocation.
    // (The runner passes the unique token it injected into the titles.)
    if (RESYNC_MARKER_TOKEN) {
      expect(
        resyncMarker.notebook_title.endsWith(RESYNC_MARKER_TOKEN),
        `RESYNC_SEED_GATE_FAILED: marker '${resyncMarker.notebook_title}' does not carry this run's token ` +
          `'${RESYNC_MARKER_TOKEN}' — stale marker from another run?`,
      ).toBe(true);
    }
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    // docker compose down -v is handled by the runner script.
  });

  it(
    'periodic sync delivers remotely added encrypted items AND decrypts them',
    async () => {
      // ------------------------------------------------------------------
      // Bounded polling: wait until the resync pair ARRIVES via the periodic
      // loop and is then DECRYPTED by it. No manual sync, no restart.
      // ------------------------------------------------------------------
      let folderSeen = false;
      let noteSeen = false;
      let bootPreconditionVerified = false;
      let lastFolders: Folder[] = [];
      let lastNotes: Note[] = [];
      const lastPollError = { message: '' };
      const deadline = Date.now() + POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS;

      while (Date.now() < deadline) {
        const folders = await callTool<{ items: Folder[]; has_more: boolean } | Folder[]>(
          client, 'list_notebooks', {},
        ).catch((err: unknown) => {
          // MCP may be transiently unreachable; keep polling within the
          // bounded window and remember why for the gate diagnostics.
          lastPollError.message = err instanceof Error ? err.message : String(err);
          return [] as Folder[];
        });

        // Some responses wrap in {items, has_more}; others return arrays.
        const folderArr: Folder[] = Array.isArray(folders) ? folders : folders.items ?? [];
        const notes = await fetchAllNotePages(lastPollError);
        lastFolders = folderArr;
        lastNotes = notes;

        // Boot precondition (once): the base fixture notebook must already be
        // decrypted — the encrypted-titles repro ran to green before this
        // test. Fatal here because "post-boot items are plaintext" is what
        // makes newly arrived encrypted items attributable to phase 2.
        if (!bootPreconditionVerified) {
          const fixture = folderArr.find((f) => f.id === seedMarker.notebook_id);
          if (fixture) {
            bootPreconditionVerified = true;
            expect(
              folderIsSafe(fixture, seedMarker.notebook_title),
              `BOOT_PRECONDITION_FAILED: base fixture notebook is not decrypted at test start ` +
                `(${describeFolder(fixture)}) — boot decrypt broken; see e2ee-encrypted-titles-repro`,
            ).toBe(true);
          }
        }

        const resyncFolder = folderArr.find((f) => f.id === resyncMarker.notebook_id);
        const resyncNote = notes.find((n) => n.id === resyncMarker.note_id);
        if (resyncFolder) folderSeen = true;
        if (resyncNote) noteSeen = true;

        if (
          resyncFolder &&
          resyncNote &&
          folderIsSafe(resyncFolder, resyncMarker.notebook_title) &&
          noteIsSafe(resyncNote, resyncMarker.note_title, resyncMarker.note_body)
        ) {
          console.log(
            `resync pair delivered and decrypted: folder=${describeFolder(resyncFolder)} note=${describeNote(resyncNote)}`,
          );
          break;
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      // ------------------------------------------------------------------
      // Attribution gate 1: arrival. The periodic sync must have DELIVERED
      // the pair. Never-arrived is a sync/harness problem, NOT the decrypt
      // defect under test — keep the failure message explicit.
      // ------------------------------------------------------------------
      expect(
        folderSeen && noteSeen,
        `RESYNC_NOT_SYNCED: phase-2 fixtures did not arrive via the periodic sync within ` +
          `${POLL_MAX_ATTEMPTS * (POLL_INTERVAL_MS / 1000)}s ` +
          `(folder ${resyncMarker.notebook_id} seen=${folderSeen}, note ${resyncMarker.note_id} seen=${noteSeen}) — ` +
          `SYNC problem, not the decrypt defect. ` +
          (lastPollError.message ? `Last MCP error: ${lastPollError.message}. ` : '') +
          `Folders returned: ${JSON.stringify(lastFolders.map((f) => ({ id: f.id, title: f.title })))}; ` +
          `note ids returned: ${JSON.stringify(lastNotes.map((n) => n.id))}`,
      ).toBe(true);

      // ------------------------------------------------------------------
      // Attribution gate 2 (THE defect): the pair arrived but stayed
      // encrypted. Pre-fix this FAILS with RESYNC_STILL_ENCRYPTED; post-fix
      // the periodic loop's decrypt step clears it.
      // ------------------------------------------------------------------
      const resyncFolder = lastFolders.find((f) => f.id === resyncMarker.notebook_id);
      expect(
        resyncFolder && folderIsSafe(resyncFolder, resyncMarker.notebook_title),
        `RESYNC_STILL_ENCRYPTED: resync folder arrived but remained encrypted — ` +
          `periodic sync does not decrypt (issue #29 comment 6072403277). Observed: ${describeFolder(resyncFolder)}`,
      ).toBe(true);

      const resyncNote = lastNotes.find((n) => n.id === resyncMarker.note_id);
      expect(
        resyncNote && noteIsSafe(resyncNote, resyncMarker.note_title, resyncMarker.note_body),
        `RESYNC_STILL_ENCRYPTED: resync note arrived but remained encrypted — ` +
          `periodic sync does not decrypt (issue #29 comment 6072403277). Observed: ${describeNote(resyncNote)}`,
      ).toBe(true);

      // Diagnostic cross-check (NOT a flip-point): the fixture notebook must
      // STILL be safe — the periodic decrypt must never re-encrypt anything.
      const fixture = lastFolders.find((f) => f.id === seedMarker.notebook_id);
      if (fixture) {
        console.log(`fixture notebook still: ${describeFolder(fixture)}`);
      }
    },
    200_000,
  );

  /** Page through list_notes (fields-limited rows; bounded page count). */
  async function fetchAllNotePages(lastPollError: { message: string }): Promise<Note[]> {
    const items: Note[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await callTool<{ items: Note[]; has_more: boolean }>(
        client, 'list_notes', { limit: 100, page },
      ).catch((err: unknown) => {
        lastPollError.message = err instanceof Error ? err.message : String(err);
        return { items: [] as Note[], has_more: false };
      });
      items.push(...res.items);
      if (!res.has_more || res.items.length === 0) break;
    }
    return items;
  }
});
