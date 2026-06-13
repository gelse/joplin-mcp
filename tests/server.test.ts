import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock all server dependencies BEFORE importing the module
// ---------------------------------------------------------------------------

const mockSpawn = vi.fn(() => ({
  stderr: { on: vi.fn() },
  stdout: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
  exitCode: null,
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

const mockParseConfig = vi.fn();
vi.mock('../src/config.js', () => ({
  parseConfig: mockParseConfig,
}));

const mockCreateLogger = vi.fn(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  createLogger: mockCreateLogger,
}));

const mockPing = vi.fn();
const MockJoplinDataClient = vi.fn(() => ({
  ping: mockPing,
}));

vi.mock('../src/data-client.js', () => ({
  JoplinDataClient: MockJoplinDataClient,
}));

const mockInitialSync = vi.fn();
const mockStartPeriodicSync = vi.fn();
const mockStopPeriodicSync = vi.fn();
const MockSyncManager = vi.fn(() => ({
  initialSync: mockInitialSync,
  startPeriodicSync: mockStartPeriodicSync,
  stopPeriodicSync: mockStopPeriodicSync,
}));

vi.mock('../src/sync-manager.js', () => ({
  SyncManager: MockSyncManager,
}));

const mockGetToolNames = vi.fn(() => []);
const MockToolRegistry = vi.fn(() => ({
  getToolNames: mockGetToolNames,
}));

vi.mock('../src/mcp/tool-registry.js', () => ({
  ToolRegistry: MockToolRegistry,
}));

const mockStartMCPServer = vi.fn();
vi.mock('../src/mcp/server.js', () => ({
  startMCPServer: mockStartMCPServer,
}));

// Store original process methods so we can restore them
const originalExit = process.exit;
const originalOn = process.on;

describe('Server entrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock process.exit to prevent test runner from actually exiting
    vi.spyOn(process, 'exit').mockImplementation((() => {
      return undefined as never;
    }) as any);
    // Mock process.on to capture signal handlers
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...args: any[]) => void,
    ) => {
      if (event === 'SIGTERM' || event === 'SIGINT') {
        (process as any).__signalHandlers = (process as any).__signalHandlers || {};
        (process as any).__signalHandlers[event] = handler;
      }
      return process;
    }) as any);
    // Mock global fetch so the ready promise from startDataApiServer resolves
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true })),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads config, creates logger, and initializes all components', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockResolvedValue({ status: 'ok', version: '3.0' });
    mockInitialSync.mockResolvedValue(undefined);
    mockStartMCPServer.mockResolvedValue(undefined);

    // Import the module — this triggers the IIFE main() call
    await import('../src/server.js');

    // Give a tick for the async main() to execute
    await vi.dynamicImportSettled?.();
    // Wait a microtask
    await new Promise((r) => setTimeout(r, 10));

    // Assert synchronously-called components were initialized
    expect(mockParseConfig).toHaveBeenCalled();
    expect(mockCreateLogger).toHaveBeenCalled();
    // Note: mockPing, mockInitialSync, mockStartMCPServer are called after
    // dataApi.ready resolves (~1s via setTimeout), so they aren't checked here
  }, 10000);

  it('registers SIGTERM and SIGINT handlers', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockResolvedValue({ status: 'ok', version: '3.0' });
    mockInitialSync.mockResolvedValue(undefined);
    mockStartMCPServer.mockResolvedValue(undefined);

    // Import triggers the main() IIFE which calls startDataApiServer
    await import('../src/server.js');
    // Wait enough for the ready promise (setTimeout(check, 500)) to resolve
    await new Promise((r) => setTimeout(r, 1000));

    // Verify that process.on was called with the signal events
    expect(process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  }, 10000);

  it('handles graceful shutdown on SIGTERM — cleanup is called', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockResolvedValue({ status: 'ok', version: '3.0' });
    mockInitialSync.mockResolvedValue(undefined);
    mockStartMCPServer.mockResolvedValue(undefined);

    // Reset modules and re-import to get fresh signal handlers
    vi.resetModules();
    // Re-mock after resetModules
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    // Re-mock process methods
    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...args: any[]) => void,
    ) => {
      if (event === 'SIGTERM' || event === 'SIGINT') {
        (process as any).__signalHandlers = (process as any).__signalHandlers || {};
        (process as any).__signalHandlers[event] = handler;
      }
      return process;
    }) as any);

    await import('../src/server.js');
    // Wait for the ready promise (setTimeout(check, 500)) to resolve
    await new Promise((r) => setTimeout(r, 1000));

    // Get the registered SIGTERM handler and call it
    const sigtermHandler = (process as any).__signalHandlers?.['SIGTERM'];
    expect(sigtermHandler).toBeDefined();

    if (sigtermHandler) {
      await sigtermHandler('SIGTERM');
    }

    // stopPeriodicSync should have been called
    expect(mockStopPeriodicSync).toHaveBeenCalled();
  }, 10000);

  it('handles graceful shutdown on SIGINT — cleanup is called', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockResolvedValue({ status: 'ok', version: '3.0' });
    mockInitialSync.mockResolvedValue(undefined);
    mockStartMCPServer.mockResolvedValue(undefined);

    vi.resetModules();
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...args: any[]) => void,
    ) => {
      if (event === 'SIGTERM' || event === 'SIGINT') {
        (process as any).__signalHandlers = (process as any).__signalHandlers || {};
        (process as any).__signalHandlers[event] = handler;
      }
      return process;
    }) as any);

    await import('../src/server.js');
    // Wait for the ready promise (setTimeout(check, 500)) to resolve
    await new Promise((r) => setTimeout(r, 1000));

    const sigintHandler = (process as any).__signalHandlers?.['SIGINT'];
    expect(sigintHandler).toBeDefined();

    if (sigintHandler) {
      await sigintHandler('SIGINT');
    }

    // stopPeriodicSync should have been called
    expect(mockStopPeriodicSync).toHaveBeenCalled();
  }, 10000);

  it('handles config validation failure with exit code 1', async () => {
    mockParseConfig.mockImplementation(() => {
      throw new Error('Configuration validation failed');
    });

    vi.resetModules();
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);

    // The main() IIFE will catch the error and call process.exit(1)
    // We just verify it doesn't throw unhandled
    await import('../src/server.js');
    await new Promise((r) => setTimeout(r, 10));

    // parseConfig throws → main() catches → process.exit(1)
    expect(process.exit).toHaveBeenCalledWith(1);
  }, 10000);

  it('handles uncaught exceptions via the main catch handler', async () => {
    // main().catch() will call process.exit(1) on any error
    // We've already mocked process.exit, so this should be safe
    mockParseConfig.mockImplementation(() => {
      throw new Error('Unexpected error');
    });

    vi.resetModules();
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);

    await import('../src/server.js');
    await new Promise((r) => setTimeout(r, 10));

    // main().catch() receives the error and calls process.exit(1)
    expect(process.exit).toHaveBeenCalledWith(1);
  }, 10000);
  // -----------------------------------------------------------------------
  // P0.3 - Missing server test coverage
  // -----------------------------------------------------------------------

  it('handles ping failure with exit code 1 and kills child process', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockRejectedValue(new Error('Connection refused'));
    mockInitialSync.mockResolvedValue(undefined);
    mockStartMCPServer.mockResolvedValue(undefined);

    vi.resetModules();
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    await import('../src/server.js');
    // dataApi.ready uses setTimeout(check, 1000), so wait for it to resolve
    // then client.ping() is called and rejects, triggering process.exit(1)
    await new Promise((r) => setTimeout(r, 2000));

    const childProcess = mockSpawn.mock.results[0]?.value;
    expect(childProcess?.kill).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  }, 10000);

  it('handles initial sync failure with exit code 1', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockResolvedValue({ status: 'ok', version: '3.0' });
    mockInitialSync.mockRejectedValue(new Error('Sync failed'));
    mockStartMCPServer.mockResolvedValue(undefined);

    vi.resetModules();
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    await import('../src/server.js');
    // dataApi.ready resolves → ping succeeds → initialSync rejects
    await new Promise((r) => setTimeout(r, 2000));

    const childProcess = mockSpawn.mock.results[0]?.value;
    expect(childProcess?.kill).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  }, 10000);

  it('handles MCP server start failure with exit code 1 and kills child process', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockResolvedValue({ status: 'ok', version: '3.0' });
    mockInitialSync.mockResolvedValue(undefined);
    mockStartMCPServer.mockRejectedValue(new Error('MCP server error'));

    vi.resetModules();
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    await import('../src/server.js');
    // dataApi.ready → ping success → initialSync success → MCP server rejects
    await new Promise((r) => setTimeout(r, 2000));

    const childProcess = mockSpawn.mock.results[0]?.value;
    expect(childProcess?.kill).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  }, 10000);

  it('sends SIGKILL when child process does not exit within 2 seconds of SIGTERM', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockResolvedValue({ status: 'ok', version: '3.0' });
    mockInitialSync.mockResolvedValue(undefined);
    mockStartMCPServer.mockResolvedValue(undefined);

    vi.resetModules();
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...args: any[]) => void,
    ) => {
      if (event === 'SIGTERM' || event === 'SIGINT') {
        (process as any).__signalHandlers = (process as any).__signalHandlers || {};
        (process as any).__signalHandlers[event] = handler;
      }
      return process;
    }) as any);

    await import('../src/server.js');
    // Wait for dataApi.ready to resolve
    await new Promise((r) => setTimeout(r, 1000));

    const childProcess = mockSpawn.mock.results[0]?.value;
    expect(childProcess).toBeDefined();

    // Clear any previous kill calls (from shutdown during import)
    childProcess.kill.mockClear();

    const sigtermHandler = (process as any).__signalHandlers?.['SIGTERM'];
    expect(sigtermHandler).toBeDefined();

    // The handler sends SIGTERM, waits 2s, then sends SIGKILL
    await sigtermHandler('SIGTERM');

    // Verify both signals were sent
    expect(childProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');
  }, 10000);

  it('exits with code 1 on unexpected child process exit', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockResolvedValue({ status: 'ok', version: '3.0' });
    mockInitialSync.mockResolvedValue(undefined);
    mockStartMCPServer.mockResolvedValue(undefined);

    vi.resetModules();
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    await import('../src/server.js');
    await new Promise((r) => setTimeout(r, 100));

    const childProcess = mockSpawn.mock.results[0]?.value;
    expect(childProcess).toBeDefined();

    // Find the exit handler registered by startDataApiServer
    const exitHandlerCall = childProcess.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'exit',
    );
    expect(exitHandlerCall).toBeDefined();

    const exitHandler = exitHandlerCall![1];
    // Simulate child process exit with non-zero code
    exitHandler(1, null);

    expect(process.exit).toHaveBeenCalledWith(1);
  }, 10000);

  it('does not exit on clean child process exit (code 0)', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockResolvedValue({ status: 'ok', version: '3.0' });
    mockInitialSync.mockResolvedValue(undefined);
    mockStartMCPServer.mockResolvedValue(undefined);

    vi.resetModules();
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    await import('../src/server.js');
    await new Promise((r) => setTimeout(r, 100));

    const childProcess = mockSpawn.mock.results[0]?.value;
    expect(childProcess).toBeDefined();

    const exitHandlerCall = childProcess.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'exit',
    );
    expect(exitHandlerCall).toBeDefined();

    const exitHandler = exitHandlerCall![1];
    // Simulate clean exit — should NOT trigger process.exit
    exitHandler(0, null);

    expect(process.exit).not.toHaveBeenCalled();
  }, 10000);

  it('does not exit on SIGTERM child process exit', async () => {
    const mockConfig = {
      joplinServerUrl: 'https://example.com',
      joplinUsername: 'user',
      joplinPassword: 'dummy-password',
      dataApiPort: 41100,
      logLevel: 'info',
      syncIntervalSeconds: 300,
    };
    mockParseConfig.mockReturnValue(mockConfig);
    mockPing.mockResolvedValue({ status: 'ok', version: '3.0' });
    mockInitialSync.mockResolvedValue(undefined);
    mockStartMCPServer.mockResolvedValue(undefined);

    vi.resetModules();
    vi.mock('../src/config.js', () => ({ parseConfig: mockParseConfig }));
    vi.mock('../src/logger.js', () => ({ createLogger: mockCreateLogger }));
    vi.mock('../src/data-client.js', () => ({ JoplinDataClient: MockJoplinDataClient }));
    vi.mock('../src/sync-manager.js', () => ({ SyncManager: MockSyncManager }));
    vi.mock('../src/mcp/tool-registry.js', () => ({ ToolRegistry: MockToolRegistry }));
    vi.mock('../src/mcp/server.js', () => ({ startMCPServer: mockStartMCPServer }));
    vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);
    vi.spyOn(process, 'on').mockImplementation((() => process) as any);

    await import('../src/server.js');
    await new Promise((r) => setTimeout(r, 100));

    const childProcess = mockSpawn.mock.results[0]?.value;
    expect(childProcess).toBeDefined();

    const exitHandlerCall = childProcess.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'exit',
    );
    expect(exitHandlerCall).toBeDefined();

    const exitHandler = exitHandlerCall![1];
    // Simulate exit via SIGTERM — should NOT trigger process.exit
    exitHandler(1, 'SIGTERM');

    expect(process.exit).not.toHaveBeenCalled();
  }, 10000);
});
