import { spawn, type ChildProcess } from 'node:child_process';
import { parseConfig } from './config.js';
import { createLogger } from './logger.js';
import { SyncManager } from './sync-manager.js';
import { JoplinDataClient } from './data-client.js';
import { ToolRegistry } from './mcp/tool-registry.js';
import { startMCPServer } from './mcp/server.js';
import type { ToolContext } from './mcp/tools.js';

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
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      console.error(`Joplin Data API exited unexpectedly (code=${code}, signal=${signal})`);
      console.error(`stderr: ${stderr}`);
      process.exit(1);
    }
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
    logger.error({ err: error }, 'Failed to ping Joplin Data API');
    dataApi.process.kill();
    process.exit(1);
  }

  // Initialize sync manager and perform initial sync
  const syncManager = new SyncManager(config, logger);

  try {
    await syncManager.initialSync();
  } catch (error) {
    logger.error({ err: error }, 'Initial sync failed, exiting');
    dataApi.process.kill();
    process.exit(1);
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
    logger.error({ err: error }, 'MCP server error');
    dataApi.process.kill();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
