import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
function toolErrorHandler(
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
