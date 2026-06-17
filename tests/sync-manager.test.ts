import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncManager } from '../src/sync-manager.js';
import type { Logger } from '../src/logger.js';
import type { Config } from '../src/config.js';
import { GuardedString } from '../src/guarded-string.js';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockSync = vi.fn<() => Promise<void>>();

vi.mock('../src/cli-executor.js', () => ({
  CliExecutor: vi.fn().mockImplementation(() => ({
    sync: mockSync,
    checkConflicts: vi.fn<() => Promise<number>>().mockResolvedValue(0),
  })),
}));

// Logger stub that satisfies the Logger interface
const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: 'silent',
} as unknown as Logger;

// ── Helpers ────────────────────────────────────────────────────────────

/** Build a fresh Config object with sensible test defaults. */
function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    joplinServerUrl: 'https://test.example.com/',
    joplinUsername: 'test@example.com',
    joplinPassword: new GuardedString('dummy-password'),
    dataApiPort: 41100,
    logLevel: 'silent',
    syncIntervalSeconds: 5,
    ...overrides,
  };
}

// ── Suite ──────────────────────────────────────────────────────────────

describe('SyncManager', () => {
  let manager: SyncManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    manager = new SyncManager(buildConfig(), mockLogger);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Initial sync ─────────────────────────────────────────────────

  describe('initialSync', () => {
    it('calls cli.sync and updates status + lastSyncTime on success', async () => {
      mockSync.mockResolvedValueOnce(undefined);

      await manager.initialSync();

      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(manager.getSyncStatus()).toBe('idle');
      expect(manager.getLastSyncTime()).toBeInstanceOf(Date);
    });

    it("sets status to 'error' and re-throws when cli.sync fails", async () => {
      const testError = new Error('sync failed');
      mockSync.mockRejectedValueOnce(testError);

      await expect(manager.initialSync()).rejects.toThrow(testError);
      expect(manager.getSyncStatus()).toBe('error');
      expect(manager.getLastSyncTime()).toBeNull();
    });

    it('logs start and completion messages', async () => {
      mockSync.mockResolvedValueOnce(undefined);
      await manager.initialSync();

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('initial sync'));
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('completed'));
    });

    it('logs error and does not set lastSyncTime on failure', async () => {
      const testError = new Error('boom');
      mockSync.mockRejectedValueOnce(testError);

      await expect(manager.initialSync()).rejects.toThrow();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: testError }),
        expect.stringContaining('failed'),
      );
      expect(manager.getLastSyncTime()).toBeNull();
    });
  });

  // ── 2. Periodic sync ────────────────────────────────────────────────

  describe('startPeriodicSync / stopPeriodicSync', () => {
    it('calls cli.sync at the configured interval', async () => {
      mockSync.mockResolvedValue(undefined);

      manager.startPeriodicSync();
      // initial tick hasn't fired yet – interval starts after the first delay
      expect(mockSync).toHaveBeenCalledTimes(0);

      // Advance past the first interval
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockSync).toHaveBeenCalledTimes(1);

      // Advance past a second interval
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockSync).toHaveBeenCalledTimes(2);
    });

    it('stopPeriodicSync clears the interval so sync is no longer called', async () => {
      mockSync.mockResolvedValue(undefined);

      manager.startPeriodicSync();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockSync).toHaveBeenCalledTimes(1);

      manager.stopPeriodicSync();
      // Advance well past another interval – should NOT fire
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mockSync).toHaveBeenCalledTimes(1);
    });

    it('is safe to call stopPeriodicSync when no timer is active', () => {
      // Must not throw
      expect(() => manager.stopPeriodicSync()).not.toThrow();
    });

    it('guards against multiple periodic sync timers (MED-007)', async () => {
      mockSync.mockResolvedValue(undefined);

      manager.startPeriodicSync();
      // Second call should be a no-op (early return)
      manager.startPeriodicSync();

      // Only one timer → only 1 sync after the first interval
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockSync).toHaveBeenCalledTimes(1);

      // Second interval still fires as normal
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockSync).toHaveBeenCalledTimes(2);

      // Verify a warning was logged about the duplicate call
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('already running'));
    });
  });

  // ── 3. Serialized sync (triggerSync queue) ──────────────────────────

  describe('triggerSync (serialized)', () => {
    it('calls cli.sync when no sync is in progress', async () => {
      mockSync.mockResolvedValueOnce(undefined);

      await manager.triggerSync('test-source');

      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(manager.getSyncStatus()).toBe('idle');
    });

    it('queues a pending sync when a sync is already running', async () => {
      // Deferred promises let us control when each sync resolves
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      let resolveSecond: () => void;
      const secondPromise = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });

      mockSync.mockReturnValueOnce(firstPromise).mockReturnValueOnce(secondPromise);

      // Start first sync
      const firstResult = manager.triggerSync('first');
      expect(manager.getSyncStatus()).toBe('syncing');

      // Queue second sync while first is in-flight
      const secondResult = manager.triggerSync('second');

      // ── at this point, syncPromise is set so the second call returned
      //    the existing promise.

      // Resolve the first sync → the finally-block sees pendingSync === true
      // and calls runSync('pending') which awaits the second deferred promise.
      // Both promises must be resolved before awaiting the shared promise.
      resolveFirst!();
      resolveSecond!();
      await firstResult;
      await secondResult;

      expect(mockSync).toHaveBeenCalledTimes(2);
      expect(manager.getSyncStatus()).toBe('idle');
    });

    it('does not queue duplicate pendings – only one pending sync is stored', async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      let resolvePending: () => void;
      const pendingPromise = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });

      mockSync.mockReturnValueOnce(firstPromise).mockReturnValueOnce(pendingPromise);

      const p1 = manager.triggerSync('first');
      const p2 = manager.triggerSync('second'); // sets pendingSync = true
      const p3 = manager.triggerSync('third'); // pendingSync already true, no change

      // Resolve both deferred promises before awaiting — the original IIFE
      // internally awaits the pending sync, so both must be settled first.
      resolveFirst!();
      resolvePending!();
      await p1;
      await p2;
      await p3;

      // Only 2 syncs: the first + one pending (third did not add another)
      expect(mockSync).toHaveBeenCalledTimes(2);
    });
  });

  // ── 4. Sync status tracking ─────────────────────────────────────────

  describe('status tracking', () => {
    it('starts with idle status and null lastSyncTime', () => {
      expect(manager.getSyncStatus()).toBe('idle');
      expect(manager.getLastSyncTime()).toBeNull();
    });

    it("is 'syncing' during initialSync and returns to 'idle' after", async () => {
      let resolveSync: () => void;
      mockSync.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        }),
      );

      const syncPromise = manager.initialSync();
      expect(manager.getSyncStatus()).toBe('syncing');

      resolveSync!();
      await syncPromise;
      expect(manager.getSyncStatus()).toBe('idle');
      expect(manager.getLastSyncTime()).toBeInstanceOf(Date);
    });
  });

  // ── 5. Error handling ───────────────────────────────────────────────

  describe('error handling', () => {
    it("sets status to 'error' and logs when triggerSync fails", async () => {
      mockSync.mockRejectedValueOnce(new Error('nope'));

      await manager.triggerSync('source-a');

      expect(manager.getSyncStatus()).toBe('error');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'source-a' }),
        expect.stringContaining('failed'),
      );
    });

    it('sets status to error on periodic sync failure (MED-008)', async () => {
      mockSync.mockRejectedValueOnce(new Error('periodic failure'));

      manager.startPeriodicSync();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(manager.getSyncStatus()).toBe('error');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('failed'),
      );
    });

    it('periodic sync continues even after individual sync failures', async () => {
      mockSync.mockRejectedValueOnce(new Error('fail-1')).mockResolvedValueOnce(undefined);

      manager.startPeriodicSync();

      // First tick → fail
      await vi.advanceTimersByTimeAsync(5_000);
      expect(manager.getSyncStatus()).toBe('error');

      // Second tick → succeed
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockSync).toHaveBeenCalledTimes(2);
      // After the successful second run status becomes "idle"
      expect(manager.getSyncStatus()).toBe('idle');
    });
  });

  // ── 6. Write-triggered sync ─────────────────────────────────────────

  describe('write-triggered sync', () => {
    it("triggerSync('write') invokes cli.sync and passes source to logs", async () => {
      mockSync.mockResolvedValueOnce(undefined);

      await manager.triggerSync('write');

      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'write' }),
        expect.stringContaining('started'),
      );
    });

    it('triggerSync returns immediately when a sync is already active', async () => {
      let resolveSync: () => void;
      mockSync.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        }),
      );

      // Fire the first (doesn't resolve)
      const p1 = manager.triggerSync('first');
      // Second call sees syncPromise set → queues pending
      const p2 = manager.triggerSync('write');

      resolveSync!();
      await p1;
      await p2;

      expect(mockSync).toHaveBeenCalledTimes(2);
    });
  });

  // ── 7. Manual trigger via triggerSync ───────────────────────────────

  describe('manual trigger', () => {
    it('triggerSync with any source triggers an immediate sync', async () => {
      mockSync.mockResolvedValueOnce(undefined);

      await manager.triggerSync('manual');

      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(manager.getLastSyncTime()).toBeInstanceOf(Date);
    });
  });

  // ── 8. Error context (getLastError) ─────────────────────────────────

  describe('getLastError', () => {
    it('returns null initially', () => {
      expect(manager.getLastError()).toBeNull();
    });

    it('returns null after a successful sync', async () => {
      mockSync.mockResolvedValueOnce(undefined);

      await manager.triggerSync('test');

      expect(manager.getLastError()).toBeNull();
    });

    it('returns the error object after a failed triggerSync', async () => {
      const testError = new Error('trigger failed');
      mockSync.mockRejectedValueOnce(testError);

      await manager.triggerSync('source');

      expect(manager.getLastError()).toBe(testError);
    });

    it('overwrites lastError on subsequent failure', async () => {
      const firstError = new Error('first failure');
      const secondError = new Error('second failure');
      mockSync.mockRejectedValueOnce(firstError).mockRejectedValueOnce(secondError);

      await manager.triggerSync('first');
      expect(manager.getLastError()).toBe(firstError);

      await manager.triggerSync('second');
      expect(manager.getLastError()).toBe(secondError);
    });

    it('clears lastError on subsequent success', async () => {
      mockSync
        .mockRejectedValueOnce(new Error('previous failure'))
        .mockResolvedValueOnce(undefined);

      await manager.triggerSync('fail');
      expect(manager.getLastError()).toBeInstanceOf(Error);

      await manager.triggerSync('ok');
      expect(manager.getLastError()).toBeNull();
    });
  });
});
