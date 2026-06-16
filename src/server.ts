import { spawn, type ChildProcess } from 'node:child_process';
import { parseConfig } from './config.js';
import { createLogger } from './logger.js';
import { SyncManager } from './sync-manager.js';
import { JoplinDataClient } from './data-client.js';
import { ToolRegistry } from './mcp/tool-registry.js';
import { startMCPServer } from './mcp/server.js';
import type { ToolContext } from './mcp/tools.js';
import type { Logger } from './logger.js';

/**
 * Centralized fatal error handler.
 * Normalizes any thrown value to an Error, logs via logger if available
 * (falls back to console.error), runs an optional cleanup callback,
 * then exits the process with the given exit code.
 */
function fatalErrorHandler(
  logger: Logger | null,
  message: string,
  error: unknown,
  cleanup?: () => void | Promise<void>,
  exitCode: number = 1,
): never {
  const normalized = error instanceof Error ? error : new Error(String(error));

  if (logger) {
    logger.error({ err: normalized }, message);
  } else {
    console.error(`${message}:`, normalized.message);
  }

  if (cleanup) {
    try {
      const result = cleanup();
      if (result instanceof Promise) {
        result.catch(() => {});
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  process.exit(exitCode);
}

/**
 * Handle a child process exit event.
 * Exits the parent process with code 1 if the child exited unexpectedly
 * (non-zero code and not a graceful shutdown signal).
 */
export function handleChildExit(
  code: number | null,
  signal: string | null,
  stderr: string,
  logger?: Logger,
): void {
  if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
    if (logger) {
      logger.error({ code, signal, stderr }, 'Joplin Data API exited unexpectedly');
    } else {
      console.error(`Joplin Data API exited unexpectedly (code=${code}, signal=${signal})`);
      console.error(`stderr: ${stderr}`);
    }
    process.exit(1);
  }
}

/**
 * Start the Joplin Data API server as a child process.
 * Returns the child process and a promise that resolves when the server is ready.
 */
function startDataApiServer(
  port: number,
  logger: import('./logger.js').Logger,
): {
  process: ChildProcess;
  ready: Promise<void>;
} {
  const child = spawn(
    'joplin',
    ['server', 'start', '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  // Drain stdout at debug level to prevent buffer backpressure
  child.stdout?.on('data', (data: Buffer) => {
    logger.trace({ stdout: data.toString().trimEnd() }, 'Joplin Data API stdout');
  });

  // Collect stderr for diagnostics
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  child.on('exit', (code, signal) => {
    handleChildExit(code, signal, stderr, logger);
  });

  // Poll the ping endpoint until the server is ready
  const ready = new Promise<void>((resolve, reject) => {
    const maxAttempts = 30;
    let attempts = 0;

    const check = async () => {
      attempts++;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ping`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Server not ready yet
      }

      if (attempts >= maxAttempts) {
        child.kill();
        reject(new Error(`Joplin Data API failed to start after ${maxAttempts} attempts`));
        return;
      }

      void setTimeout(() => {
        void check();
      }, 1000);
    };

    // Give the child process a moment to start before first ping
    void setTimeout(() => {
      void check();
    }, 1000);
  });

  return { process: child, ready };
}

async function main(): Promise<void> {
  // Parse and validate configuration
  const config = parseConfig();

  // Initialize structured logger
  const logger = createLogger(config);

  logger.info('Joplin API MCP Server starting');
  logger.debug({ config }, 'Configuration loaded');

  // Start the Joplin Data API server
  logger.info({ port: config.dataApiPort }, 'Starting Joplin Data API server');
  const dataApi = startDataApiServer(config.dataApiPort, logger);

  await dataApi.ready;
  logger.info('Joplin Data API server is ready');

  // Initialize data client (connects to the Data API)
  const client = new JoplinDataClient(config.dataApiPort, logger);

  // Verify connectivity
  try {
    const ping = await client.ping();
    logger.info({ status: ping.status, version: ping.version }, 'Data API ping successful');
  } catch (error) {
    fatalErrorHandler(logger, 'Failed to ping Joplin Data API', error, () => {
      dataApi.process.kill();
    });
  }

  // Initialize sync manager and perform initial sync
  const syncManager = new SyncManager(config, logger);

  try {
    await syncManager.initialSync();
  } catch (error) {
    fatalErrorHandler(logger, 'Initial sync failed, exiting', error, () => {
      dataApi.process.kill();
    });
  }

  // Start periodic sync
  syncManager.startPeriodicSync();

  // Create tool context shared by all MCP tool handlers
  const toolContext: ToolContext = {
    client,
    syncManager,
    logger,
  };

  // Initialize tool registry
  const registry = new ToolRegistry();
  logger.info({ tools: registry.getToolNames() }, 'Tool registry initialized');

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');
    syncManager.stopPeriodicSync();

    // Kill the Data API child process
    if (dataApi.process.exitCode === null) {
      logger.info('Stopping Joplin Data API server');
      dataApi.process.kill('SIGTERM');

      // Give it a moment to shut down gracefully
      await new Promise((resolve) => setTimeout(resolve, 2000));

      if (dataApi.process.exitCode === null) {
        dataApi.process.kill('SIGKILL');
      }
    }

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  logger.info('Joplin API MCP Server ready, starting MCP on stdio');

  // Start MCP server (blocks on stdio transport)
  try {
    await startMCPServer(registry, toolContext, logger);
  } catch (error) {
    fatalErrorHandler(logger, 'MCP server error', error, () => {
      dataApi.process.kill();
    });
  }
}

main().catch((error) => {
  fatalErrorHandler(null, 'Fatal error', error);
});
