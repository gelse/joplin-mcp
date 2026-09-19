/**
 * SQLITE_BUSY destructive-migration reproduction test (issue #27).
 *
 * Holds an exclusive SQLite write lock via a second Node/better-sqlite3
 * process inside the joplin-mcp container, triggers `joplin sync`, and
 * asserts the destructive log signatures that prove the CLI concluded
 * the database version was null and ran schema migrations from version 0.
 *
 * **This test must FAIL against the current container code** — proving
 * the bug exists — and is designed to flip to PASS once M2's fixes land.
 *
 * Gated behind `RUN_SYNC_LOCK_TESTS=1` (separate from the normal
 * integration test suite because it is slow and deliberately destructive
 * to a throwaway volume).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { createTestClient, callTool, uid, CleanupTracker } from './helpers.js';

// ---------------------------------------------------------------------------
// Gate: entire suite skipped unless RUN_SYNC_LOCK_TESTS=1
// ---------------------------------------------------------------------------
const RUN_SYNC_LOCK_TESTS = process.env['RUN_SYNC_LOCK_TESTS'] === '1';
const describeIfSyncLock = RUN_SYNC_LOCK_TESTS ? describe : describe.skip;

// Container name must match `container_name` in docker-compose.test.yml
const JOPLIN_CONTAINER = process.env['JOPLIN_CONTAINER'] || 'joplin-mcp';

// Lock holder must keep the exclusive lock for longer than the sync attempt.
// 90 s lock vs 60 s sync timeout = 30 s margin (>5 s as required by plan).
const LOCK_DURATION_MS = 90_000;
const LOCK_WAIT_MS = 3_000;
const SYNC_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface NoteResult {
  id: string;
  title: string;
}

interface FolderResult {
  id: string;
  title: string;
}

interface NoteListResult {
  items: NoteResult[];
  has_more: boolean;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describeIfSyncLock('SQLITE_BUSY destructive migration repro (issue #27)', () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;
  let lockHolder: ChildProcess | null = null;
  const cleanup = new CleanupTracker();

  // -- Seed data via MCP tools ---------------------------------------------
  beforeAll(async () => {
    client = await createTestClient();

    const folder = await callTool<FolderResult>(client, 'create_folder', {
      title: `repro-folder-${uid()}`,
    });
    cleanup.trackFolder(folder.id);

    const note = await callTool<NoteResult>(client, 'create_note', {
      title: `repro-note-${uid()}`,
      parent_id: folder.id,
      body: 'Test note for SQLITE_BUSY destructive migration repro',
    });
    cleanup.trackNote(note.id);

    // Verify seed data exists before proceeding
    const notesBefore = await callTool<NoteListResult>(client, 'list_notes', {
      limit: 100,
    });
    expect(notesBefore.items.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  // -- Cleanup -------------------------------------------------------------
  afterAll(async () => {
    if (lockHolder && !lockHolder.killed) {
      lockHolder.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1_000));
    }
    // Best-effort — MCP may be broken after destructive migration
    await cleanup.cleanup(client).catch(() => {});
    await client?.close().catch(() => {});
  });

  // -- Test ----------------------------------------------------------------
  it(
    'concurrent joplin sync under exclusive write lock causes destructive migration',
    async () => {
      // ------------------------------------------------------------------
      // Step 1: Acquire exclusive SQLite write lock
      // ------------------------------------------------------------------
      // The lock-holder script opens database.sqlite with better-sqlite3
      // (a transitive dep of globally-installed joplin@3.7.1), takes
      // BEGIN EXCLUSIVE, and sleeps for LOCK_DURATION_MS.
      const lockScript = [
        'let Database;',
        'try {',
        "  Database = require('better-sqlite3');",
        '} catch (e) {',
        "  const fs = require('fs');",
        "  const path = require('path');",
        "  const bases = ['/usr/local/lib/node_modules', '/usr/lib/node_modules'];",
        '  for (const base of bases) {',
        "    const candidate = path.join(base, 'joplin', 'node_modules', 'better-sqlite3');",
        '    if (fs.existsSync(candidate)) { Database = require(candidate); break; }',
        '  }',
        "  if (!Database) { console.error('better-sqlite3 not found'); process.exit(1); }",
        '}',
        "const db = new Database('/home/joplin/.config/joplin/database.sqlite');",
        "db.pragma('journal_mode = WAL');",
        "db.exec('BEGIN EXCLUSIVE');",
        "console.log('LOCK_HELD');",
        `setTimeout(() => { try { db.close(); } catch(e) {} process.exit(0); }, ${LOCK_DURATION_MS});`,
      ].join('\n');

      // Write lock-holder to a temp file, docker cp into the container
      const tmpFile = '/tmp/sqlite-lock-holder.js';
      writeFileSync(tmpFile, lockScript);
      try {
        execSync(`docker cp ${tmpFile} ${JOPLIN_CONTAINER}:/tmp/lock-holder.js`, {
          encoding: 'utf-8',
        });
      } finally {
        try {
          unlinkSync(tmpFile);
        } catch {
          /* ignore */
        }
      }

      // Start the lock holder in the background
      lockHolder = spawn(
        'docker',
        ['exec', JOPLIN_CONTAINER, 'node', '/tmp/lock-holder.js'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );

      // Wait for the lock to be established
      await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));

      // ------------------------------------------------------------------
      // Step 2: Trigger joplin sync (should hit SQLITE_BUSY)
      // ------------------------------------------------------------------
      let syncOutput = '';
      let syncExitCode = 0;
      try {
        syncOutput = execSync(
          `docker exec ${JOPLIN_CONTAINER} joplin sync`,
          { encoding: 'utf-8', timeout: SYNC_TIMEOUT_MS },
        );
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        syncOutput =
          ((e.stdout as string) || '') + ((e.stderr as string) || '');
        syncExitCode = e.status ?? 1;
      }

      console.log('=== Sync output ===');
      console.log(syncOutput);
      console.log('=== Sync exit code:', syncExitCode, '===');

      // ------------------------------------------------------------------
      // Step 3: Collect container logs for additional evidence
      // ------------------------------------------------------------------
      let containerLogs = '';
      try {
        containerLogs = execSync(
          `docker logs --tail 100 ${JOPLIN_CONTAINER} 2>&1`,
          { encoding: 'utf-8' },
        );
      } catch {
        /* ignore log-collection errors */
      }

      const combinedOutput = syncOutput + '\n' + containerLogs;

      // ------------------------------------------------------------------
      // Step 4: Check note count after sync
      // ------------------------------------------------------------------
      let noteCountAfter = -1;
      try {
        const notesAfter = await callTool<NoteListResult>(client, 'list_notes', {
          limit: 100,
        });
        noteCountAfter = notesAfter.items.length;
      } catch {
        // MCP may be broken after destructive migration — treat as 0
        noteCountAfter = 0;
      }
      console.log('Note count after sync:', noteCountAfter);

      // ================================================================
      // Safe-behaviour assertions — FAIL on current buggy code (issue #27)
      //
      // On current code these assertions FAIL because:
      //   1. SQLITE_BUSY leaks into output
      //   2. CLI treats version as null, runs migration from version 0
      //   3. All notes are destroyed (count = 0)
      //
      // This proves the destructive bug exists.
      // ================================================================

      const hasSqliteBusy = /SQLITE_BUSY|database is locked/i.test(
        combinedOutput,
      );
      expect(
        hasSqliteBusy,
        'SQLITE_BUSY or "database is locked" should NOT appear in output (currently does — bug present)',
      ).toBe(false);

      const hasUpgradeFromZero =
        /Upgrading database from version 0/i.test(combinedOutput);
      expect(
        hasUpgradeFromZero,
        '"Upgrading database from version 0" should NOT appear (currently does — destructive migration)',
      ).toBe(false);

      expect(
        noteCountAfter,
        'Notes should be preserved after sync (currently 0 — data destroyed)',
      ).toBeGreaterThanOrEqual(1);

      // ================================================================
      // TODO(M2): flip assertions to safe behaviour
      //
      // After M2 fix, replace the three assertions above with:
      //
      // const hasAbortMarker =
      //   /\[SYNC_ABORT\]|circuit.?breaker|sync.*abort/i.test(combinedOutput);
      // expect(hasAbortMarker, 'Expected sync abort marker in output').toBe(true);
      // expect(hasUpgradeFromZero, 'Should not see destructive migration').toBe(false);
      // expect(noteCountAfter, 'Notes should be preserved').toBeGreaterThanOrEqual(1);
      // expect(syncExitCode, 'Sync should exit non-zero or log refusal').not.toBe(0);
      // ================================================================
    },
    150_000, // 150 s: 90 s lock + 60 s sync timeout + 30 s margin
  );
});
