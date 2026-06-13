import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '../../src/logger.js';

// ---------------------------------------------------------------------------
// Mocks — all vi.mock() calls MUST be at the top level.
// Variables used by vi.mock factory functions MUST be declared before each
// vi.mock call (const/let at module scope are fine since factories run
// lazily when the module is first imported).
// ---------------------------------------------------------------------------

const mockToolFn = vi.fn();
let mockConnect = vi.fn();

/** McpServer mock — both createMCPServer and startMCPServer use it. */
const mockMcpServerInstance = {
  tool: mockToolFn,
  get connect() {
    return mockConnect;
  },
  set connect(fn: any) {
    mockConnect = fn;
  },
};

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn(() => mockMcpServerInstance),
}));

const mockTransportInstance = {};

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(() => mockTransportInstance),
}));

const mockGetAllTools = vi.fn();
const mockGetToolNames = vi.fn(() => []);
const mockExecuteTool = vi.fn();
const mockRegistry = {
  getAllTools: mockGetAllTools,
  getToolNames: mockGetToolNames,
  executeTool: mockExecuteTool,
};

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
} as unknown as Logger;

const mockCtx = {
  client: {} as any,
  syncManager: {} as any,
  logger: mockLogger,
};

describe('MCP Server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect = vi.fn(); // fresh connect mock per test
    Object.defineProperty(mockMcpServerInstance, 'connect', {
      get: () => mockConnect,
      set: (fn: any) => {
        mockConnect = fn;
      },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('createMCPServer', () => {
    it('returns a properly configured McpServer', async () => {
      mockGetAllTools.mockReturnValue([]);

      const { createMCPServer } = await import('../../src/mcp/server.js');
      const server = await createMCPServer(mockRegistry as any, mockCtx as any, mockLogger);

      expect(server).toBeDefined();
      expect(server).toEqual(mockMcpServerInstance);
    });

    it('registers all tools on server creation', async () => {
      const mockTools = [
        {
          name: 'list_notebooks',
          description: 'List notebooks',
          schema: { _def: { shape: {} } },
        },
        {
          name: 'search_notes',
          description: 'Search notes',
          schema: { _def: { shape: { query: 'string' } } },
        },
        {
          name: 'sync',
          description: 'Trigger sync',
          schema: { _def: { shape: {} } },
        },
      ];
      mockGetAllTools.mockReturnValue(mockTools);

      const { createMCPServer } = await import('../../src/mcp/server.js');
      await createMCPServer(mockRegistry as any, mockCtx as any, mockLogger);

      expect(mockToolFn).toHaveBeenCalledTimes(3);
      expect(mockToolFn).toHaveBeenCalledWith(
        'list_notebooks',
        'List notebooks',
        {},
        expect.any(Function),
      );
      expect(mockToolFn).toHaveBeenCalledWith(
        'search_notes',
        'Search notes',
        { query: 'string' },
        expect.any(Function),
      );
    });

    it('registers tool handler that delegates to registry.executeTool', async () => {
      mockGetAllTools.mockReturnValue([
        {
          name: 'list_notebooks',
          description: 'List notebooks',
          schema: { _def: { shape: {} } },
        },
      ]);

      const { createMCPServer } = await import('../../src/mcp/server.js');
      await createMCPServer(mockRegistry as any, mockCtx as any, mockLogger);

      const handler = mockToolFn.mock.calls[0][3];

      await handler({});

      expect(mockExecuteTool).toHaveBeenCalledWith('list_notebooks', {}, mockCtx);
    });

    it('logs debug when a tool is called', async () => {
      mockGetAllTools.mockReturnValue([
        {
          name: 'test_tool',
          description: 'Test',
          schema: { _def: { shape: {} } },
        },
      ]);
      mockExecuteTool.mockResolvedValue({ result: 'ok' });

      const { createMCPServer } = await import('../../src/mcp/server.js');
      await createMCPServer(mockRegistry as any, mockCtx as any, mockLogger);

      const handler = mockToolFn.mock.calls[0][3];
      await handler({ input: 'data' });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { tool: 'test_tool', input: { input: 'data' } },
        'MCP tool called',
      );
    });

    it('handles tool handler errors gracefully', async () => {
      mockGetAllTools.mockReturnValue([
        {
          name: 'failing_tool',
          description: 'Fails',
          schema: { _def: { shape: {} } },
        },
      ]);

      const testError = new Error('Something went wrong');
      mockExecuteTool.mockRejectedValue(testError);

      const { createMCPServer } = await import('../../src/mcp/server.js');
      await createMCPServer(mockRegistry as any, mockCtx as any, mockLogger);

      const handler = mockToolFn.mock.calls[0][3];
      const result = await handler({});

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: 'Error executing failing_tool: Something went wrong',
          },
        ],
        isError: true,
      });
    });
  });

  describe('startMCPServer', () => {
    it('connects the server using StdioServerTransport', async () => {
      mockGetAllTools.mockReturnValue([]);

      // resetModules clears the module cache so a fresh McpServer instance
      // is created from the registered mock factory, which returns
      // mockMcpServerInstance with the current mockConnect getter.
      vi.resetModules();

      const { startMCPServer } = await import('../../src/mcp/server.js');
      await startMCPServer(mockRegistry as any, mockCtx as any, mockLogger);

      expect(mockConnect).toHaveBeenCalledWith(mockTransportInstance);
    });

    it('creates StdioServerTransport', async () => {
      mockGetAllTools.mockReturnValue([]);

      vi.resetModules();

      const { startMCPServer } = await import('../../src/mcp/server.js');
      await startMCPServer(mockRegistry as any, mockCtx as any, mockLogger);

      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      expect(StdioServerTransport).toHaveBeenCalledOnce();
    });
  });
});
