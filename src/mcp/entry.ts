import { parseConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { JoplinDataClient } from '../data-client.js';
import { ToolRegistry } from './tool-registry.js';
import { startMCPHttpServer } from './server.js';
import type { ToolContext } from './tools.js';

/**
 * MCP HTTP server entrypoint: starts the MCP HTTP server that runs
 * alongside the Joplin Data API in the combined container. All Joplin
 * data operations go through the Data API over HTTP (loopback).
 * Periodic sync is owned by the entrypoint's bash scheduler, so no
 * SyncManager is wired here.
 */
async function main(): Promise<void> {
  const config = parseConfig();

  // Validate required configuration
  if (!config.joplinCoreUrl) {
    console.error('FATAL: JOPLIN_CORE_URL is required but not set');
    console.error('Set JOPLIN_CORE_URL to the Data API URL (e.g. http://127.0.0.1:41184)');
    process.exit(1);
  }

  if (!config.joplinApiToken) {
    console.error('FATAL: JOPLIN_API_TOKEN is required but not set');
    process.exit(1);
  }

  const logger = createLogger(config);

  // Create Data API client pointing at the local Data API
  const client = new JoplinDataClient(
    config.joplinCoreUrl,
    config.joplinApiToken,
    logger,
  );

  // Verify Data API connectivity
  try {
    const ping = await client.ping();
    logger.info({ status: ping.status, version: ping.version }, 'Connected to Data API');
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to the Data API');
    console.error('FATAL: Could not reach the Data API at', config.joplinCoreUrl);
    console.error('Ensure the Data API is running and healthy before starting the MCP server');
    process.exit(1);
  }

  // Build tool context — no SyncManager; the entrypoint's bash scheduler owns syncing
  const ctx: ToolContext = {
    client,
    logger,
    // syncManager intentionally omitted — periodic sync is handled by the entrypoint's scheduler
  };

  // Initialize tool registry (tools are statically defined at module level)
  const registry = new ToolRegistry();
  logger.info({ tools: registry.getToolNames() }, 'Tool registry initialized');

  const port = parseInt(process.env['MCP_PORT'] ?? '3000', 10);
  const httpServer = await startMCPHttpServer(registry, ctx, logger, port);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, closing MCP HTTP server');
    httpServer.close(() => {
      logger.info('MCP HTTP server closed');
      process.exit(0);
    });
    // Force exit after timeout
    setTimeout(() => {
      logger.warn('Forced shutdown after timeout');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  logger.info({ port }, `Joplin MCP HTTP server ready on port ${port}`);
}

main().catch((error) => {
  console.error('Fatal error starting MCP HTTP server:', error);
  process.exit(1);
});
