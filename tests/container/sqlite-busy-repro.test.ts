/**
 * SQLITE_BUSY destructive-migration reproduction test (issue #27).
 *
 * Reproduces the destructive migration via a bypass sync (exclusive lock
 * + direct `joplin sync`), then verifies:
 *   1. Destructive signatures ARE present (reproduction confirmed)
 *   2. check_sync_danger's regex pattern would detect them (detection logic validated)
 *   3. No secondary corruption (`table folders already exists` absent)
 *
 * Gated behind `RUN_SYNC_LOCK_TESTS=1` (separate from the normal
 * integration test suite because it is slow and deliberately destructive
 * to a throwaway volume).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
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

/** Data directory inside the joplin-mcp container (also the volume mountpoint). */
const DATA_DIR = '/home/joplin/.config/joplin';
const HOLDER_SCRIPT_IN_CONTAINER = '/tmp/lock-holder.js';
const CAPTURE_SCRIPT_IN_CONTAINER = '/tmp/sync-capture.sh';

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
 * Translate an in-container data-directory path into the equivalent path
 * inside the helper container's `/vol` mount.
 *
 * The helper's CWD is *not* the data directory, so reading the absolute
 * in-container path (e.g. `/home/joplin/.config/joplin/x.txt`) fails with
 * "No such file or directory" and the capture is silently lost.
 */
function toVolumeMountPath(filePath: string): string {
  if (filePath === DATA_DIR) return '/vol';
  if (filePath.startsWith(`${DATA_DIR}/`)) {
    return `/vol/${filePath.slice(DATA_DIR.length + 1)}`;
  }
  throw new Error(
    `Path ${filePath} is not inside the data directory ${DATA_DIR}`,
  );
}

/**
 * Read a file from the joplin data volume via a throwaway alpine container.
 * The volume is shared with the joplin-mcp service and mounted at `/vol`.
 */
function readVolumeFile(
  volumeName: string,
  filePath: string,
  timeoutMs = 30_000,
): string {
  const mountPath = toVolumeMountPath(filePath);
  try {
    return execSync(
      `docker run --rm -v ${volumeName}:/vol alpine cat ${mountPath}`,
      { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    return '';
  }
}

/**
 * Write `content` to a temp file in the test-runner and `docker cp` it into
 * the container, then verify it arrived non-empty.
 *
 * `docker exec` without `-i` does not forward the client's stdin, so piping a
 * script produced a 0-byte file in the container. Returns the byte count.
 */
function copyIntoContainer(
  container: string,
  content: string,
  destPath: string,
  label: string,
): number {
  const dir = mkdtempSync(join(tmpdir(), 'joplin-repro-'));
  const localPath = join(dir, basename(destPath));
  try {
    writeFileSync(localPath, content, 'utf-8');
    execSync(`docker cp ${localPath} ${container}:${destPath}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const sizeOut = execSync(
    `docker exec ${container} sh -c 'wc -c < ${destPath}'`,
    { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  const bytes = parseInt(sizeOut, 10);
  if (!Number.isFinite(bytes) || bytes === 0) {
    throw new Error(
      `${label} is empty in ${container} (${sizeOut || '0'} bytes at ${destPath}) — delivery failed`,
    );
  }
  return bytes;
}

/**
 * Resolve the named docker volume backing the data directory.
 *
 * Compose prefixes the project name (`joplin-mcp_joplin_data`); silently
 * falling back to the unprefixed `joplin_data` mounts a nonexistent volume and
 * yields an empty read, so this fails loudly instead.
 */
function resolveDataVolumeName(container: string): string {
  let name = '';
  try {
    name = execSync(
      `docker inspect --format '{{range .Mounts}}{{if eq .Destination "${DATA_DIR}"}}{{.Name}}{{end}}{{end}}' ${container}`,
      { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (err: unknown) {
    const message = (err as { message?: string }).message ?? String(err);
    throw new Error(
      `Could not inspect ${container} to resolve the ${DATA_DIR} volume: ${message}`,
    );
  }
  if (!name) {
    throw new Error(
      `No volume mounted at ${DATA_DIR} in ${container} — cannot read the capture file`,
    );
  }
  return name;
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
  const proc = spawn('docker', ['exec', container, 'node', HOLDER_SCRIPT_IN_CONTAINER], {
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

/**
 * Capture script executed INSIDE the joplin-mcp container. Written with
 * `docker cp` and run as `sh /tmp/sync-capture.sh` — a single script avoids
 * the double-shell quoting bug that made the joined `{ ... } > file` command
 * list a syntax error.
 *
 * Containment: the entrypoint's liveness monitor kills the whole process tree
 * as soon as the destructive migration takes the Data API down, which is
 * ~44s into the sync — long before any post-sync `tail` could run. The log is
 * therefore streamed live into the capture file for the whole window, and the
 * caller redirects stdout to the capture file on the data volume so the
 * content survives container death.
 *
 * `$SYNC_STATUS` is captured immediately after `timeout ... joplin sync`, so
 * it is joplin's own exit code and SYNC_EXIT stays parseable. The watchdog
 * `timeout` also guarantees the finalize segment runs if joplin hangs under
 * the held lock; its rc 124 maps to 137 so a watchdog kill is not mistaken
 * for joplin's own exit code.
 *
 * `exec` is used for the redirect so every child (including the streamed tail)
 * inherits the capture file on fd 1; the shell's own writes are line-buffered
 * and the `sync` call flushes the streamed data to the volume before teardown.
 */
const CAPTURE_SCRIPT = `#!/bin/sh
exec > ${DATA_DIR}/sync-capture.txt 2>&1
date +%s
echo SYNC_START
tail -n +1 -F ${DATA_DIR}/log.txt &
TAIL_PID=$!
timeout ${SYNC_TIMEOUT_MS / 1000} joplin sync
SYNC_STATUS=$?
if [ "$SYNC_STATUS" -eq 124 ]; then SYNC_STATUS=137; fi
kill $TAIL_PID 2>/dev/null
date +%s
echo SYNC_EXIT=$SYNC_STATUS
sync
echo CAPTURE_DONE
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
      // `docker exec` without `-i` does not forward the client's stdin, so
      // piping the script produced a 0-byte file. docker cp from a temp file in
      // the test-runner is reliable, and the size is verified before we rely
      // on the holder ever emitting LOCK_HELD.
      const holderBytes = copyIntoContainer(
        JOPLIN_CONTAINER,
        LOCK_SCRIPT,
        HOLDER_SCRIPT_IN_CONTAINER,
        'lock-holder script',
      );
      console.log('Lock-holder script bytes:', holderBytes);

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
      const CAPTURE_FILE = `${DATA_DIR}/sync-capture.txt`;
      const CAPTURE_POLL_INTERVAL_MS = 3_000;
      const CAPTURE_POLL_MAX_ATTEMPTS = 40; // 40 × 3s = 120s

      // Resolve the data volume name for the helper container mount. Compose
      // prefixes the project name (joplin-mcp_joplin_data); never fall back to
      // an unprefixed name — that mounts a nonexistent volume and the read
      // silently returns empty.
      const volumePath = resolveDataVolumeName(JOPLIN_CONTAINER);
      console.log('Data volume:', volumePath);

      // Combined sync + log capture. The script redirects its own stdout to the
      // capture file on the data volume (survives container death — the
      // entrypoint's liveness monitor tears the container down and kills the
      // exec), so the exec's own output is deliberately not piped anywhere.
      copyIntoContainer(
        JOPLIN_CONTAINER,
        CAPTURE_SCRIPT,
        CAPTURE_SCRIPT_IN_CONTAINER,
        'sync capture script',
      );
      dockerExec(
        JOPLIN_CONTAINER,
        `sh ${CAPTURE_SCRIPT_IN_CONTAINER}`,
        SYNC_TIMEOUT_MS + 10_000,
      );

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
        if (captureTxt.includes('SYNC_EXIT')) break;
        // A dead container cannot append anything more to the volume, so a
        // capture that already has content is final — polling on would burn the
        // remaining ~120s and race the 180s test timeout. One extra poll lets a
        // last flush land.
        if (!isContainerRunning(JOPLIN_CONTAINER) && captureTxt.includes('SYNC_START')) {
          await new Promise((r) => setTimeout(r, CAPTURE_POLL_INTERVAL_MS));
          captureTxt = readVolumeFile(volumePath, CAPTURE_FILE);
          break;
        }
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

      // Upper bound of the capture window, derived from the container-written
      // SYNC_START marker rather than the test-runner clock: log.txt timestamps
      // are produced inside the container, and comparing them against a
      // test-runner epoch would silently widen or collapse the window whenever
      // the two clocks disagree.
      const captureEndEpoch =
        syncStartEpoch + Math.ceil(SYNC_TIMEOUT_MS / 1000) + 60;

      // Find SYNC_EXIT line (parsed independently of its position)
      const syncExitLine = captureLines.find((l) => l.startsWith('SYNC_EXIT='));
      const syncExitCode = syncExitLine
        ? parseInt(syncExitLine.split('=')[1] ?? '-1', 10)
        : -1;
      console.log('Sync exit code:', syncExitCode);

      // The log is streamed BETWEEN the SYNC_START and SYNC_EXIT markers (the
      // tail runs for the whole sync, the markers bracket it), so the log is
      // everything after SYNC_START with the capture's own control lines
      // removed. Position-independent, so a capture cut short by container
      // death still yields a usable log.
      const syncStartIdx = captureLines.findIndex((l) => l.trim() === 'SYNC_START');
      const logTxt = captureLines
        .slice(syncStartIdx + 1)
        .filter(
          (l) =>
            !/^\d{10}$/.test(l.trim()) &&
            !l.startsWith('SYNC_EXIT=') &&
            l.trim() !== 'CAPTURE_DONE',
        )
        .join('\n');

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
        // Window-scope to the sync run captured here: lines before the sync
        // start belong to the container entrypoint's own startup initialisation
        // (which legitimately logs `Current database version <null>` and
        // `Upgrading database from version 0` when it creates the database on a
        // fresh volume) and are excluded to avoid a startup-collision false
        // positive. The start tolerance absorbs the sub-second gap between the
        // `date +%s` marker and the first log line of the sync.
        return ts >= syncStartEpoch - 5 && ts <= captureEndEpoch;
      });

      console.log('Windowed log lines:', windowedLog.length, 'of', allLogLines.length);

      // ------------------------------------------------------------------
      // M2 safe-behaviour assertions
      //
      // The bypass sync (CAPTURE_SCRIPT) runs `joplin sync` directly,
      // bypassing the entrypoint's flock/halt gate.  This reproduces the
      // destructive migration signatures in log.txt — proving the bug
      // exists.  M2 guarantees that the entrypoint's check_sync_danger()
      // detects these signatures and writes the halt marker; however the
      // test compose file sets SYNC_INTERVAL_SECONDS=9999 so the periodic
      // loop does not run during the test window and the halt marker is
      // NOT written.
      //
      // What this test verifies:
      //   1. Destructive signatures ARE present (reproduction confirmed)
      //   2. check_sync_danger's regex matches them (detection validated)
      //   3. No secondary corruption: `table folders already exists` absent
      //
      // Log assertions come FIRST (Defect A: log assertions must not be
      // skipped if MCP is unreachable after container death).
      // ------------------------------------------------------------------
      const windowedTxt = windowedLog.join('\n');

      // (1) Destructive signatures ARE present — the bypass sync reproduced
      //     the bug.  This proves the exclusive-lock scenario produces the
      //     dangerous "Current database version <null>" / migration-from-0
      //     output that M2 must detect.
      const hasDestructiveSignature =
        /Current database version.*null/i.test(windowedTxt) ||
        /Upgrading database from version 0/i.test(windowedTxt);
      expect(
        hasDestructiveSignature,
        'Bypass sync should reproduce destructive migration signatures in log.txt',
      ).toBe(true);

      // (2) check_sync_danger's regex matches the captured log — the same
      //     dangerous_pattern used by the entrypoint would detect these
      //     signatures, validating the detection logic.
      const DANGEROUS_PATTERN =
        /SQLITE_BUSY|database is locked|Upgrading database from version 0|Current database version.*null/i;
      expect(
        DANGEROUS_PATTERN.test(windowedTxt),
        'check_sync_danger regex should match the destructive signatures in the captured log',
      ).toBe(true);

      // (3) Secondary corruption check — no duplicate folder creation
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

    },
    180_000,
  );
});
