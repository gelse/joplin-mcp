/**
 * SQLITE_BUSY destructive-migration reproduction test (issue #27).
 *
 * Holds an exclusive SQLite write lock via a plain Node process inside
 * the joplin-mcp container (using the image's built-in sqlite3 module),
 * triggers `joplin sync`, and asserts the destructive log signatures
 * that prove the CLI concluded the database version was null and ran
 * schema migrations from version 0 — destroying all data.
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
import { createInterface } from 'readline';
import { writeFileSync, unlinkSync } from 'fs';
import { createTestClient, callTool, uid, CleanupTracker } from './helpers.js';

// ---------------------------------------------------------------------------
// Gate: entire suite skipped unless RUN_SYNC_LOCK_TESTS=1
// ---------------------------------------------------------------------------
const RUN_SYNC_LOCK_TESTS = process.env['RUN_SYNC_LOCK_TESTS'] === '1';
const describeIfSyncLock = RUN_SYNC_LOCK_TESTS ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const JOPLIN_CONTAINER = process.env['JOPLIN_CONTAINER'] || 'joplin-mcp';
const HOLDER_LIFETIME_MS = 120_000; // outlasts joplin's ~43s retry budget
const SETTLE_MS = 2_000;
const SYNC_TIMEOUT_MS = 150_000;

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
// Helpers
// ---------------------------------------------------------------------------

/** Run a docker exec command and return { stdout, stderr, exitCode }. */
function dockerExec(
  container: string,
  cmd: string,
  timeoutMs = 60_000,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(
      `docker exec ${container} ${cmd}`,
      { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: (e.stdout as string) || '',
      stderr: (e.stderr as string) || '',
      exitCode: e.status ?? 1,
    };
  }
}

/**
 * Release the in-container lock holder by killing the PID written to
 * /tmp/lock-holder.pid.  The joplin-mcp image lacks pkill/pgrep, so
 * the holder writes its own PID to a file instead.
 */
function releaseLock(container: string): void {
  try {
    execSync(
      `docker exec ${container} sh -c 'kill -9 "$(cat /tmp/lock-holder.pid)" 2>/dev/null; exit 0'`,
      { encoding: 'utf-8', timeout: 5_000 },
    );
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Spawn `node /tmp/lock-holder.js` inside the container and read its
 * stdout line-by-line. Resolves when the holder emits `LOCK_HELD`.
 * Rejects if the holder exits before emitting `LOCK_HELD`.
 */
function spawnLockHolder(
  container: string,
): { result: Promise<void>; proc: ChildProcess } {
  const proc = spawn('docker', ['exec', container, 'node', '/tmp/lock-holder.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lockHeld = false;

  const result = new Promise<void>((resolve, reject) => {
    // Collect stderr for diagnostics
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (lockHeld) return;
      if (trimmed === 'LOCK_HELD') {
        lockHeld = true;
        resolve();
        rl.close();
        return;
      }
      if (
        trimmed.startsWith('OPEN_FAIL') ||
        trimmed.startsWith('BEGIN_FAIL') ||
        trimmed.startsWith('STMT_FAIL')
      ) {
        reject(new Error(`Lock holder failed: ${trimmed}`));
        rl.close();
        return;
      }
    });

    rl.on('close', () => {
      if (!lockHeld) {
        reject(
          new Error(
            `Lock holder exited before LOCK_HELD. stderr: ${stderrBuf}`,
          ),
        );
      }
    });

    proc.on('error', (err) => {
      if (!lockHeld) reject(err);
    });

    proc.on('exit', (code) => {
      if (!lockHeld) {
        reject(
          new Error(
            `Lock holder exited (code ${code}) before LOCK_HELD. stderr: ${stderrBuf}`,
          ),
        );
      }
    });
  });

  return { result, proc };
}

// ---------------------------------------------------------------------------
// Lock-holder script (uses the image's sqlite3 module, NOT better-sqlite3)
// ---------------------------------------------------------------------------
const LOCK_SCRIPT = `const s = require('/usr/local/lib/node_modules/joplin/node_modules/sqlite3').verbose();
const db = new s.Database('/home/joplin/.config/joplin/database.sqlite', s.OPEN_READWRITE, (err) => {
  if (err) { console.error('OPEN_FAIL', err.message); process.exit(1); }
  require('fs').writeFileSync('/tmp/lock-holder.pid', String(process.pid));
  // Allow up to 10s busy-wait per SQLite call so transient contention from
  // concurrent suites doesn't immediately fail BEGIN EXCLUSIVE.
  db.run('PRAGMA busy_timeout = 10000', (pe) => {
    if (pe) { console.error('OPEN_FAIL', pe.message); process.exit(1); }
    db.serialize(() => {
      // Retry BEGIN EXCLUSIVE with exponential backoff (500ms ×1.5^n, up to ~30s)
      // to survive transient SQLITE_BUSY from in-flight writes by other suites.
      let delay = 500;
      const MAX_TOTAL_MS = 30000;
      const startTime = Date.now();
      function tryBegin() {
        db.run('BEGIN EXCLUSIVE', (e) => {
          if (e && e.message && e.message.includes('SQLITE_BUSY') && (Date.now() - startTime) < MAX_TOTAL_MS) {
            setTimeout(tryBegin, delay);
            delay = Math.round(delay * 1.5);
            return;
          }
          if (e) { console.error('BEGIN_FAIL', e.message); process.exit(1); }
          // CRITICAL: bare BEGIN EXCLUSIVE holds no lock; a statement inside the txn does.
          db.get('SELECT count(*) AS n FROM sqlite_master', (e2) => {
            if (e2) { console.error('STMT_FAIL', e2.message); process.exit(1); }
            console.log('LOCK_HELD');
            setTimeout(() => db.run('ROLLBACK', () => db.close()), Number(process.env.HOLD_MS || ${HOLDER_LIFETIME_MS}));
          });
        });
      }
      tryBegin();
    });
  });
});
`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describeIfSyncLock('SQLITE_BUSY destructive migration repro (issue #27)', () => {
  let client: Awaited<ReturnType<typeof createTestClient>>;
  let holderProc: ChildProcess | null = null;
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
    // Best-effort kill of lock holder
    if (holderProc && !holderProc.killed) {
      holderProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1_000));
    }
    releaseLock(JOPLIN_CONTAINER);
    // Best-effort — MCP may be broken after destructive migration
    await cleanup.cleanup(client).catch(() => {});
    await client?.close().catch(() => {});
  });

  // -- Test ----------------------------------------------------------------
  it(
    'concurrent joplin sync under exclusive write lock causes destructive migration',
    async () => {
      // ------------------------------------------------------------------
      // Step 1: Write lock-holder script into container
      // ------------------------------------------------------------------
      const tmpFile = '/tmp/sqlite-lock-holder.js';
      writeFileSync(tmpFile, LOCK_SCRIPT);
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

      // ------------------------------------------------------------------
      // Step 2: Spawn lock holder and await LOCK_HELD
      // ------------------------------------------------------------------
      const holder = spawnLockHolder(JOPLIN_CONTAINER);
      holderProc = holder.proc;
      await holder.result; // blocks until LOCK_HELD is emitted

      // ------------------------------------------------------------------
      // Step 3: Mechanism self-validation — probe confirms lock is held
      // ------------------------------------------------------------------
      // node-sqlite3's open callback receives only (err) — NOT (err, db).
      // The Database instance must come from the enclosing scope.
      const probe = dockerExec(
        JOPLIN_CONTAINER,
        `node -e "const s=require('/usr/local/lib/node_modules/joplin/node_modules/sqlite3');const db=new s.Database('/home/joplin/.config/joplin/database.sqlite',s.OPEN_READWRITE,(e)=>{if(e){console.error('OPEN_ERR',e.message);process.exit(1)}db.run('BEGIN EXCLUSIVE',(e)=>{if(e){console.log('PROBE_BUSY',e.message);process.exit(0)}db.run('ROLLBACK',()=>db.close(()=>{console.log('PROBE_ACQUIRED');process.exit(2)}))})})"`,
        15_000,
      );
      // PROBE_BUSY in stdout = lock is held (desired)
      // exit 1 = lock NOT held (unexpected)
      const probeBusy = probe.stdout.includes('PROBE_BUSY');
      expect(
        probeBusy,
        `Expected SQLITE_BUSY probe to fail (PROBE_BUSY). probe: stdout=${probe.stdout} stderr=${probe.stderr} exit=${probe.exitCode}`,
      ).toBe(true);

      // ------------------------------------------------------------------
      // Step 4: Settle before launching sync
      // ------------------------------------------------------------------
      await new Promise((r) => setTimeout(r, SETTLE_MS));

      // ------------------------------------------------------------------
      // Step 5: Trigger joplin sync
      // ------------------------------------------------------------------
      const sync = dockerExec(JOPLIN_CONTAINER, 'joplin sync', SYNC_TIMEOUT_MS);
      const syncOut = sync.stdout;
      const syncErr = sync.stderr;

      // Lock is no longer needed once sync has exited; release it
      // to keep MCP/Data API responsive for post-sync checks and
      // to avoid leaking into subsequent test files.
      releaseLock(JOPLIN_CONTAINER);
      holderProc?.kill('SIGTERM');

      console.log('=== Sync stdout ===');
      console.log(syncOut);
      console.log('=== Sync stderr ===');
      console.log(syncErr);
      console.log('=== Sync exit code:', sync.exitCode, '===');

      // ------------------------------------------------------------------
      // Step 6: Read log.txt (NOT docker logs) for migration evidence
      // ------------------------------------------------------------------
      const logCapture = dockerExec(
        JOPLIN_CONTAINER,
        'tail -n 300 /home/joplin/.config/joplin/log.txt',
        15_000,
      );
      const logTxt = logCapture.stdout;

      console.log('=== log.txt (last 300 lines) ===');
      console.log(logTxt);

      // ------------------------------------------------------------------
      // Step 7: Check note count after sync
      // ------------------------------------------------------------------
      let noteCountAfter = -1;
      try {
        const notesAfter = await callTool<NoteListResult>(client, 'list_notes', {
          limit: 100,
        });
        noteCountAfter = notesAfter.items.length;
      } catch {
        // MCP may be broken after destructive migration
        throw new Error(
          'MCP unreachable after sync — data destroyed',
        );
      }
      console.log('Note count after sync:', noteCountAfter);

      // ------------------------------------------------------------------
      // Safe-behaviour assertions — FAIL on current buggy code (issue #27)
      // On current code these fail with captured logTxt / syncOutput visible
      // in vitest diff.
      // ------------------------------------------------------------------
      expect(logTxt).not.toContain('Current database version <null>');
      expect(logTxt).not.toContain('Upgrading database from version 0');
      expect(syncOut + syncErr).not.toContain('table folders already exists');
      expect(noteCountAfter).toBeGreaterThanOrEqual(1);

      // TODO(M2): no assertion edits required — the assertions above are the safe
      // behavior. Optionally tighten after M2 lands: assert the specific abort
      // marker (e.g. [SYNC_ABORT] / circuit-breaker halt) in sync output, and
      // assert 'Upgrading database from version 53' (or the seeded version) in log.txt.
    },
    180_000,
  );
});
