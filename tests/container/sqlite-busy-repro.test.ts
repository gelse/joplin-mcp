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

/** Check whether a named Docker container is in running state. */
function isContainerRunning(name: string): boolean {
  try {
    const out = execSync(
      `docker inspect --format '{{.State.Running}}' ${name}`,
      { encoding: 'utf-8', timeout: 5_000 },
    ).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

/**
 * Read a file from the joplin data volume via a throwaway alpine container.
 * The volume is shared with the joplin-mcp service (joplin_data).
 */
function readVolumeFile(
  volumePath: string,
  filePath: string,
  timeoutMs = 30_000,
): string {
  try {
    return execSync(
      `docker run --rm -v ${volumePath}:/vol alpine cat ${filePath}`,
      { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    return '';
  }
}

/**
 * Parse a log.txt timestamp line (`YYYY-MM-DD HH:MM:SS:`) and return
 * epoch seconds for comparison with the sync-start marker.
 */
function parseLogTimestamp(line: string): number | null {
  const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}):/);
  if (!match) return null;
  return Math.floor(new Date(match[1] + 'Z').getTime() / 1000);
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
      // Pipe the lock-holder script directly into the container (no temp file needed)
      execSync(
        `docker exec ${JOPLIN_CONTAINER} sh -c "cat > /tmp/lock-holder.js"`,
        { input: LOCK_SCRIPT, encoding: 'utf-8', timeout: 10_000 },
      );

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
      // Step 5+6: Volume-backed capture — exec stdout is unreliable because
      // the entrypoint liveness monitor tears down the container when the
      // Data API dies during the destructive migration, killing the exec
      // (rc 137) before output reaches the pipe. Volume writes survive
      // container death, so we capture to a file on the data volume and
      // read it back via a helper container.
      // ------------------------------------------------------------------
      const CAPTURE_FILE = '/home/joplin/.config/joplin/sync-capture.txt';
      const CAPTURE_POLL_INTERVAL_MS = 3_000;
      const CAPTURE_POLL_MAX_ATTEMPTS = 40; // 40 × 3s = 120s

      // Resolve the data volume name for the helper container mount.
      // The joplin_data volume is mounted at /home/joplin/.config/joplin.
      let volumePath = '';
      try {
        volumePath = execSync(
          `docker inspect --format '{{range .Mounts}}{{if eq .Destination "/home/joplin/.config/joplin"}}{{.Name}}{{end}}{{end}}' ${JOPLIN_CONTAINER}`,
          { encoding: 'utf-8', timeout: 10_000 },
        ).trim();
      } catch { /* fallback below */ }
      if (!volumePath) volumePath = 'joplin_data';
      console.log('Data volume:', volumePath);

      // Combined sync + log capture — everything written to the capture file
      // on the data volume; exec stdout is ignored (will die with container).
      const combinedCmd = [
        '{ date +%s; echo SYNC_START;',
        'joplin sync;',
        'echo "SYNC_EXIT=$?";',
        'sleep 2;',
        'tail -n 1000 /home/joplin/.config/joplin/log.txt;',
        'echo CAPTURE_DONE; }',
        `> ${CAPTURE_FILE} 2>&1`,
      ].join(' ');
      dockerExec(JOPLIN_CONTAINER, combinedCmd, SYNC_TIMEOUT_MS + 10_000);

      // Lock is no longer needed once sync has exited; release it
      // to keep MCP/Data API responsive for post-sync checks and
      // to avoid leaking into subsequent test files.
      releaseLock(JOPLIN_CONTAINER);
      holderProc?.kill('SIGTERM');

      // Poll for the capture file (bounded, 120s max)
      let captureTxt = '';
      const deadline = Date.now() + CAPTURE_POLL_MAX_ATTEMPTS * CAPTURE_POLL_INTERVAL_MS;
      while (Date.now() < deadline) {
        captureTxt = readVolumeFile(volumePath, CAPTURE_FILE);
        if (captureTxt.includes('CAPTURE_DONE')) break;
        // Container may be dead — if file has SYNC_EXIT, treat as sufficient
        if (!isContainerRunning(JOPLIN_CONTAINER) && captureTxt.includes('SYNC_EXIT')) break;
        await new Promise((r) => setTimeout(r, CAPTURE_POLL_INTERVAL_MS));
      }
      if (!captureTxt) {
        captureTxt = readVolumeFile(volumePath, CAPTURE_FILE);
      }

      console.log('=== Volume capture ===');
      console.log(captureTxt.slice(0, 4000));

      const captureLines = captureTxt.split('\n');

      // First non-empty line: sync start epoch
      const syncStartEpoch = parseInt(captureLines[0]?.trim() ?? '0', 10);
      console.log('Sync start epoch:', syncStartEpoch);

      // Find SYNC_EXIT line
      const syncExitLine = captureLines.find((l) => l.startsWith('SYNC_EXIT='));
      const syncExitCode = syncExitLine
        ? parseInt(syncExitLine.split('=')[1] ?? '-1', 10)
        : -1;
      console.log('Sync exit code:', syncExitCode);

      // Everything after SYNC_EXIT line is log.txt tail content
      const syncExitIdx = captureLines.indexOf(syncExitLine ?? '');
      const logTxt = captureLines.slice(syncExitIdx + 1).join('\n');

      console.log('=== log.txt tail ===');
      console.log(logTxt.slice(0, 3000));

      // ------------------------------------------------------------------
      // Capture preconditions — a missing or empty capture must be an honest
      // test failure, never a vacuous pass.
      // ------------------------------------------------------------------
      expect(
        Number.isFinite(syncStartEpoch),
        `Capture missing or corrupt: syncStartEpoch=${syncStartEpoch} (expected a finite integer)`,
      ).toBe(true);
      expect(
        logTxt.trim().length,
        `Captured log text is empty — capture file may be missing or truncated`,
      ).toBeGreaterThan(0);

      // ------------------------------------------------------------------
      // Step 7: Window-scope log assertions — volume-backed capture reads
      // survived container death (Defect C: skip startup-collision lines)
      // ------------------------------------------------------------------
      const allLogLines = logTxt.split('\n');
      const windowedLog = allLogLines.filter((line) => {
        const ts = parseLogTimestamp(line);
        if (ts === null) return true;  // continuation lines without timestamps
        return ts >= syncStartEpoch;
      });

      console.log('Windowed log lines:', windowedLog.length, 'of', allLogLines.length);

      // ------------------------------------------------------------------
      // Safe-behaviour assertions — FAIL on current buggy code (issue #27)
      // Log assertions come FIRST (Defect A: log assertions must not be
      // skipped if MCP is unreachable after container death).
      // ------------------------------------------------------------------
      const windowedTxt = windowedLog.join('\n');
      expect(windowedTxt).not.toContain('Current database version <null>');
      expect(windowedTxt).not.toContain('Upgrading database from version 0');
      expect(logTxt).not.toContain('table folders already exists');

      // ------------------------------------------------------------------
      // Step 8: Best-effort MCP note count (Defect A: soft failure)
      // ------------------------------------------------------------------
      let noteCountAfter: number | null = null;
      try {
        const notesAfter = await callTool<NoteListResult>(client, 'list_notes', {
          limit: 100,
        });
        noteCountAfter = notesAfter.items.length;
        console.log('Note count after sync:', noteCountAfter);
      } catch {
        console.warn('MCP unreachable after sync — cannot verify note count (expected when container dies)');
      }

      if (noteCountAfter !== null) {
        expect(noteCountAfter).toBeGreaterThanOrEqual(1);
      } else {
        console.warn('Skipping note-count assertion: MCP unreachable');
      }

      // TODO(M2): no assertion edits required — the assertions above are the safe
      // behavior. Optionally tighten after M2 lands: assert the specific abort
      // marker (e.g. [SYNC_ABORT] / circuit-breaker halt) in sync output, and
      // assert 'Upgrading database from version 53' (or the seeded version) in log.txt.
    },
    180_000,
  );
});
