import type { Logger } from "./logger.js";
import type { Config } from "./config.js";
import { CliExecutor } from "./cli-executor.js";

export type SyncStatus = "idle" | "syncing" | "error";

export class SyncManager {
  private status: SyncStatus = "idle";
  private lastSyncTime: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingSync = false;
  private syncPromise: Promise<void> | null = null;
  private readonly cli: CliExecutor;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger
  ) {
    this.cli = new CliExecutor(logger);
  }

  getSyncStatus(): SyncStatus {
    return this.status;
  }

  getLastSyncTime(): Date | null {
    return this.lastSyncTime;
  }

  /**
   * Perform initial sync on startup. Must complete before proceeding.
   */
  async initialSync(): Promise<void> {
    this.logger.info("Performing initial sync");
    this.status = "syncing";
    try {
      await this.cli.sync();
      this.lastSyncTime = new Date();
      this.status = "idle";
      this.logger.info("Initial sync completed");
    } catch (error) {
      this.status = "error";
      this.logger.error({ err: error }, "Initial sync failed");
      throw error;
    }
  }

  /**
   * Start periodic sync timer.
   */
  startPeriodicSync(): void {
    const intervalMs = this.config.syncIntervalSeconds * 1000;
    this.logger.info(
      { intervalSeconds: this.config.syncIntervalSeconds },
      "Starting periodic sync"
    );

    this.timer = setInterval(() => {
      this.runSync("periodic").catch((err) => {
        this.logger.error({ err }, "Periodic sync failed");
      });
    }, intervalMs);

    // Prevent timer from keeping process alive during shutdown
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
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
      this.logger.info("Periodic sync stopped");
    }
  }

  /**
   * Trigger a sync after a write operation.
   * Uses serialized execution: if a sync is already running, marks a pending
   * sync that will execute after the current one completes.
   */
  async triggerSync(source: string): Promise<void> {
    this.logger.debug({ source }, "Sync triggered by write operation");

    if (this.syncPromise) {
      // A sync is already running — mark pending
      this.pendingSync = true;
      this.logger.debug("Sync already in progress, pending sync queued");
      return this.syncPromise;
    }

    return this.runSync(source);
  }

  private async runSync(source: string): Promise<void> {
    this.syncPromise = (async () => {
      this.status = "syncing";
      this.logger.info({ source }, "Sync started");

      try {
        await this.cli.sync();
        this.lastSyncTime = new Date();
        this.status = "idle";
        this.logger.info({ source }, "Sync completed");
      } catch (error) {
        this.status = "error";
        this.logger.error({ err: error, source }, "Sync failed");
      } finally {
        this.syncPromise = null;
      }

      // If a sync was queued while this one was running, execute it now
      if (this.pendingSync) {
        this.pendingSync = false;
        this.logger.debug("Executing queued pending sync");
        await this.runSync("pending");
      }
    })();

    return this.syncPromise;
  }
}
