import type { Logger } from './logger.js';
import type { Config } from './config.js';
import { CliExecutor } from './cli-executor.js';

export type SyncStatus = 'idle' | 'syncing' | 'error';

export class SyncManager {
  private status: SyncStatus = 'idle';
  private lastSyncTime: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingSync = false;
  private syncPromise: Promise<void> | null = null;
  private lastError: Error | null = null;
  private readonly cli: CliExecutor;

  /**
   * Creates a SyncManager instance.
   *
   * @param config - Application configuration (includes sync interval, Joplin Server URL, etc.)
   * @param logger - Pino structured logger instance
   */
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.cli = new CliExecutor(logger);
  }

  /**
   * Returns the current sync status.
   *
   * @returns The current status: `'idle'`, `'syncing'`, or `'error'`
   */
  getSyncStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Returns the timestamp of the last successful sync.
   *
   * @returns A Date object if a sync has completed, or `null` if no sync has run yet
   */
  getLastSyncTime(): Date | null {
    return this.lastSyncTime;
  }

  /**
   * Returns the last sync error, if any.
   *
   * @returns The last error encountered during sync, or `null` if the last sync succeeded
   */
  getLastError(): Error | null {
    return this.lastError;
  }

  /**
   * Perform initial sync on startup. Must complete before proceeding.
   */
  async initialSync(): Promise<void> {
    this.logger.info('Performing initial sync');
    this.status = 'syncing';
    try {
      await this.cli.sync();
      this.lastSyncTime = new Date();
      this.status = 'idle';
      this.logger.info('Initial sync completed');
    } catch (error) {
      this.status = 'error';
      this.logger.error({ err: error }, 'Initial sync failed');
      throw error;
    } finally {
      // Issue #29: every sync — success or failure — is followed by an E2EE
      // decrypt pass. decryptAfterSync never throws, so this cannot mask
      // the sync outcome above.
      await this.decryptAfterSync('initial');
    }
  }

  /**
   * Start periodic sync timer.
   */
  startPeriodicSync(): void {
    if (this.timer) {
      this.logger.warn('Periodic sync already running, ignoring duplicate start');
      return;
    }

    const intervalMs = this.config.syncIntervalSeconds * 1000;
    this.logger.info(
      { intervalSeconds: this.config.syncIntervalSeconds },
      'Starting periodic sync',
    );

    this.timer = setInterval(() => {
      this.runSync('periodic').catch((err) => {
        this.status = 'error';
        this.logger.error({ err }, 'Periodic sync failed');
      });
    }, intervalMs);

    // Prevent timer from keeping process alive during shutdown
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  /**
   * Stop periodic sync timer.
   */
  stopPeriodicSync(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Periodic sync stopped');
    }
  }

  /**
   * Trigger a sync after a write operation.
   * Uses serialized execution: if a sync is already running, marks a pending
   * sync that will execute after the current one completes.
   */
  async triggerSync(source: string): Promise<void> {
    this.logger.debug({ source }, 'Sync triggered by write operation');

    if (this.syncPromise) {
      // A sync is already running — mark pending
      this.pendingSync = true;
      this.logger.debug('Sync already in progress, pending sync queued');
      return this.syncPromise;
    }

    return this.runSync(source);
  }

  private async runSync(source: string): Promise<void> {
    this.syncPromise = (async () => {
      this.status = 'syncing';
      this.logger.info({ source }, 'Sync started');

      try {
        await this.cli.sync();
        this.lastSyncTime = new Date();
        this.status = 'idle';
        this.lastError = null;
        this.logger.info({ source }, 'Sync completed');
      } catch (error) {
        this.status = 'error';
        this.lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.error({ err: error, source }, 'Sync failed');
      } finally {
        this.syncPromise = null;
      }

      // Issue #29: every sync — success or failure — is followed by an E2EE
      // decrypt pass (decryptAfterSync never throws). A queued pending sync
      // decrypts after its own sync via the recursive runSync below.
      await this.decryptAfterSync(source);

      // If a sync was queued while this one was running, execute it now
      if (this.pendingSync) {
        this.pendingSync = false;
        this.logger.debug('Executing queued pending sync');
        await this.runSync('pending');
      }
    })();

    return this.syncPromise;
  }

  /**
   * Post-sync E2EE decrypt pass (issue #29: every sync is followed by a
   * decrypt). Mirrors the entrypoint's shell-side gating: with no
   * JOPLIN_MASTER_PASSWORD configured, E2EE was never enabled here and the
   * CLI call is skipped (logged). Failures are logged and never propagated —
   * a decrypt problem must not fail the sync that just completed; the next
   * sync cycle retries naturally.
   */
  private async decryptAfterSync(source: string): Promise<void> {
    if (!process.env['JOPLIN_MASTER_PASSWORD']) {
      this.logger.debug(
        { source },
        'JOPLIN_MASTER_PASSWORD not configured — skipping post-sync E2EE decrypt',
      );
      return;
    }
    try {
      await this.cli.e2eeDecrypt();
      this.logger.info({ source }, 'Post-sync E2EE decrypt completed');
    } catch (error) {
      this.logger.warn(
        { err: error, source },
        'Post-sync E2EE decrypt failed — synced items may remain encrypted until the next sync cycle',
      );
    }
  }
}
