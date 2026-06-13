import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Logger } from "../logger.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolContext } from "./tools.js";
import { ZodError } from "zod";

export async function createMCPServer(
  registry: ToolRegistry,
  ctx: ToolContext,
  logger: Logger
): Promise<McpServer> {
  const server = new McpServer({
    name: "joplin-api-mcp",
    version: "0.1.0",
  });

  // Register all tools from the registry
  for (const tool of registry.getAllTools()) {
    server.tool(
      tool.name,
      tool.description,
      // Convert Zod schema to a plain object shape for MCP SDK
      (tool.schema._def as any)?.shape ?? {},
      async (input: unknown) => {
        logger.debug({ tool: tool.name, input }, "MCP tool called");
        try {
          const result = await registry.executeTool(tool.name, input, ctx);
          // Convert result to MCP content format
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          // Handle Zod validation errors
          if (error instanceof ZodError) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Validation error: ${error.errors
                    .map((e) => `${e.path.join(".")}: ${e.message}`)
                    .join("; ")}`,
                },
              ],
              isError: true,
            };
          }

          logger.error(
            { tool: tool.name, err: error },
            "MCP tool execution failed"
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `Error executing ${tool.name}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    logger.debug({ tool: tool.name }, "Registered MCP tool");
  }

  logger.info(
    { toolCount: registry.getToolNames().length },
    "MCP server created with all tools registered"
  );

  return server;
}

export async function startMCPServer(
  registry: ToolRegistry,
  ctx: ToolContext,
  logger: Logger
): Promise<void> {
  const server = await createMCPServer(registry, ctx, logger);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server started on stdio transport");
}
