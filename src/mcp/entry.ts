import { parseConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { JoplinDataClient } from '../data-client.js';
import { ToolRegistry } from './tool-registry.js';
import { startMCPHttpServer } from './server.js';
import type { ToolContext } from './tools.js';

/**
 * Container B entrypoint: starts the MCP HTTP server.
 *
 * This container is stateless — it has no Joplin CLI, no SyncManager,
 * and no direct filesystem access. All Joplin data operations are
 * proxied to Container A (joplin-core) via HTTP.
 */
async function main(): Promise<void> {
  const config = parseConfig();

  // Validate Container B requirements
  if (!config.joplinCoreUrl) {
    console.error('FATAL: JOPLIN_CORE_URL is required for the MCP container');
    console.error('Set JOPLIN_CORE_URL to the URL of the joplin-core Data API (e.g. http://joplin-core:41184)');
    process.exit(1);
  }

  if (!config.joplinApiToken) {
    console.error('FATAL: JOPLIN_API_TOKEN is required for the MCP container');
    process.exit(1);
  }

  const logger = createLogger(config);

  // Create DataClient pointing to Container A's Data API
  const client = new JoplinDataClient(
    config.joplinCoreUrl,
    config.joplinApiToken,
    logger,
  );

  // Verify connectivity to Container A
  try {
    const ping = await client.ping();
    logger.info({ status: ping.status, version: ping.version }, 'Connected to joplin-core Data API');
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to joplin-core Data API');
    console.error('FATAL: Could not reach joplin-core at', config.joplinCoreUrl);
    console.error('Ensure Container A is running and healthy before starting Container B');
    process.exit(1);
  }

  // Build tool context — no SyncManager, sync is handled by Container A
  const ctx: ToolContext = {
    client,
    logger,
    // syncManager intentionally omitted — Container A manages sync
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
