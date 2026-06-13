import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('ToolRegistry', () => {
  let ToolRegistry: any;
  let registry: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/mcp/tool-registry.js');
    ToolRegistry = mod.ToolRegistry;
    registry = new ToolRegistry();
  });

  // =========================================================================
  // Tool listing
  // =========================================================================

  it('getAllTools returns all 16 registered tools', () => {
    const tools = registry.getAllTools();
    expect(tools).toHaveLength(16);
  });

  it('getToolNames returns all 16 tool names', () => {
    const names = registry.getToolNames();
    expect(names).toHaveLength(16);
    expect(names).toContain('list_notebooks');
    expect(names).toContain('search_notes');
    expect(names).toContain('read_note');
    expect(names).toContain('read_notebook');
    expect(names).toContain('read_multinote');
    expect(names).toContain('read_tags');
    expect(names).toContain('create_note');
    expect(names).toContain('create_folder');
    expect(names).toContain('edit_note');
    expect(names).toContain('edit_folder');
    expect(names).toContain('create_tag');
    expect(names).toContain('tag_note');
    expect(names).toContain('untag_note');
    expect(names).toContain('delete_note');
    expect(names).toContain('delete_folder');
    expect(names).toContain('sync');
  });

  it('getAllTools returns tools with name, description, schema, and handler', () => {
    const tools = registry.getAllTools();
    for (const tool of tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('schema');
      expect(tool).toHaveProperty('handler');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('all tool names are unique', () => {
    const tools = registry.getAllTools();
    const names = tools.map((t: any) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  // =========================================================================
  // getTool
  // =========================================================================

  it('getTool returns a RegisteredTool for a known tool name', () => {
    const tool = registry.getTool('list_notebooks');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('list_notebooks');
    expect(tool.description).toBe('List all notebooks/folders in Joplin');
  });

  it('getTool returns undefined for an unknown tool name', () => {
    const tool = registry.getTool('nonexistent_tool');
    expect(tool).toBeUndefined();
  });

  // =========================================================================
  // executeTool
  // =========================================================================

  it('executeTool dispatches to the correct handler with parsed input', async () => {
    // list_notebooks needs no args and calls client.getAllFolders()
    const mockGetAllFolders = vi.fn().mockResolvedValue([{ id: 'f1', title: 'Notes' }]);
    const mockClient = {
      getAllFolders: mockGetAllFolders,
      search: vi.fn(),
      getNote: vi.fn(),
      getFolder: vi.fn(),
      getNoteTags: vi.fn(),
      createNote: vi.fn(),
      createFolder: vi.fn(),
      updateNote: vi.fn(),
      updateFolder: vi.fn(),
      createTag: vi.fn(),
      tagNote: vi.fn(),
      untagNote: vi.fn(),
      deleteNote: vi.fn(),
      deleteFolder: vi.fn(),
    } as any;

    const mockSyncManager = {
      triggerSync: vi.fn(),
      getSyncStatus: vi.fn(),
      getLastSyncTime: vi.fn(),
    } as any;

    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any;

    const ctx = {
      client: mockClient,
      syncManager: mockSyncManager,
      logger: mockLogger,
    };

    const result = await registry.executeTool('list_notebooks', {}, ctx);

    expect(mockGetAllFolders).toHaveBeenCalledOnce();
    expect(result).toEqual([{ id: 'f1', title: 'Notes' }]);
  });

  it('executeTool throws for an unknown tool name', async () => {
    const ctx = {
      client: {} as any,
      syncManager: {} as any,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    await expect(registry.executeTool('unknown_tool', {}, ctx)).rejects.toThrow(
      'Unknown tool: unknown_tool',
    );
  });

  it('executeTool throws validation error for invalid input', async () => {
    const ctx = {
      client: {
        search: vi.fn(),
        getAllFolders: vi.fn(),
        getNote: vi.fn(),
        getFolder: vi.fn(),
        getNoteTags: vi.fn(),
        createNote: vi.fn(),
        createFolder: vi.fn(),
        updateNote: vi.fn(),
        updateFolder: vi.fn(),
        createTag: vi.fn(),
        tagNote: vi.fn(),
        untagNote: vi.fn(),
        deleteNote: vi.fn(),
        deleteFolder: vi.fn(),
      } as any,
      syncManager: {} as any,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    // search_notes requires 'query' field
    await expect(registry.executeTool('search_notes', {}, ctx)).rejects.toThrow();
  });

  it('executeTool propagates handler errors', async () => {
    const mockError = new Error('API failure');
    const mockClient = {
      getAllFolders: vi.fn().mockRejectedValue(mockError),
      search: vi.fn(),
      getNote: vi.fn(),
      getFolder: vi.fn(),
      getNoteTags: vi.fn(),
      createNote: vi.fn(),
      createFolder: vi.fn(),
      updateNote: vi.fn(),
      updateFolder: vi.fn(),
      createTag: vi.fn(),
      tagNote: vi.fn(),
      untagNote: vi.fn(),
      deleteNote: vi.fn(),
      deleteFolder: vi.fn(),
    } as any;

    const ctx = {
      client: mockClient,
      syncManager: {} as any,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    await expect(registry.executeTool('list_notebooks', {}, ctx)).rejects.toThrow('API failure');
  });
});
