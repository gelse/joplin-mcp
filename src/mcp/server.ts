import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Logger } from '../logger.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolContext } from './tools.js';
import { ZodError } from 'zod';
import { extractSchemaShape } from './schemas.js';

/**
 * Unified error handler for MCP tool execution.
 * Logs ZodError at warn level (client error) and everything else at error level.
 * Always returns an MCP error response with { content, isError: true }.
 */
export function toolErrorHandler(
  toolName: string,
  error: unknown,
  logger: Logger,
): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  if (error instanceof ZodError) {
    logger.warn({ tool: toolName, err: error }, 'MCP tool validation error');
    return {
      content: [
        {
          type: 'text' as const,
          text: `Validation error: ${error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; ')}`,
        },
      ],
      isError: true,
    };
  }

  logger.error({ tool: toolName, err: error }, 'MCP tool execution failed');
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error executing ${toolName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    ],
    isError: true,
  };
}

export async function createMCPServer(
  registry: ToolRegistry,
  ctx: ToolContext,
  logger: Logger,
): Promise<McpServer> {
  const server = new McpServer({
    name: 'joplin-api-mcp',
    version: '0.1.0',
  });

  // Register all tools from the registry
  for (const tool of registry.getAllTools()) {
    server.tool(
      tool.name,
      tool.description,
      // Convert Zod schema to a plain object shape for MCP SDK
      extractSchemaShape(tool.schema),
      async (input: unknown) => {
        logger.debug({ tool: tool.name, input }, 'MCP tool called');
        try {
          const result = await registry.executeTool(tool.name, input, ctx);
          // Convert result to MCP content format
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          return toolErrorHandler(tool.name, error, logger);
        }
      },
    );

    logger.debug({ tool: tool.name }, 'Registered MCP tool');
  }

  logger.info(
    { toolCount: registry.getToolNames().length },
    'MCP server created with all tools registered',
  );

  return server;
}

export async function startMCPServer(
  registry: ToolRegistry,
  ctx: ToolContext,
  logger: Logger,
): Promise<void> {
  const server = await createMCPServer(registry, ctx, logger);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('MCP server started on stdio transport');
}

/**
 * Start the MCP server as a stateless HTTP server.
 *
 * Uses StreamableHTTPServerTransport with sessionIdGenerator set to undefined
 * for stateless operation — each request is handled independently, with no
 * session state persisted between calls.
 *
 * Adds a /health endpoint that returns { status: 'ok' } for Docker healthchecks.
 *
 * @returns The raw Node.js http.Server instance for graceful shutdown handling.
 */
export async function startMCPHttpServer(
  registry: ToolRegistry,
  ctx: ToolContext,
  logger: Logger,
  port: number = 3000,
): Promise<ReturnType<typeof createServer>> {
  const server = await createMCPServer(registry, ctx, logger);

  // Stateless transport: no session tracking between requests
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);
  logger.info('MCP server connected to stateless HTTP transport');

  // Create raw Node.js HTTP server
  const httpServer = createServer(async (req, res) => {
    // Health check endpoint for Docker healthcheck
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error({ err: error, url: req.url }, 'Error handling MCP request');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(port, () => {
      logger.info({ port }, 'MCP HTTP server started');
      resolve(httpServer);
    });
    httpServer.on('error', (err) => {
      logger.error({ err }, 'HTTP server error');
      reject(err);
    });
  });
}
