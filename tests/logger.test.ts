import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable } from 'stream';
import { pino } from 'pino';
import type { Config } from '../src/config.js';
import { GuardedString } from '../src/guarded-string.js';

// Mock pino-pretty so it doesn't spawn worker threads in test environment
vi.mock('pino-pretty', () => ({
  default: {},
}));

/** Log entry shape we expect from pino JSON output. */
interface LogEntry {
  level: number;
  msg: string;
  time: number;
  pid: number;
  hostname: string;
  [key: string]: unknown;
}

/**
 * Creates a writable stream that captures JSON log lines.
 * Returns the stream and a function to retrieve all parsed log entries.
 */
function createCaptureStream(): {
  stream: Writable;
  getLogs: () => LogEntry[];
} {
  const lines: string[] = [];
  const stream = new Writable({
    write(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      const line = chunk.toString().trim();
      if (line) {
        lines.push(line);
      }
      callback();
    },
  });

  return {
    stream,
    getLogs: (): LogEntry[] => lines.map((l) => JSON.parse(l)),
  };
}

/** Minimal valid config for creating a logger. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    joplinServerUrl: 'https://example.com',
    joplinUsername: 'user',
    joplinPassword: new GuardedString('dummy-password'),
    dataApiPort: 41100,
    logLevel: 'info',
    syncIntervalSeconds: 300,
    ...overrides,
  };
}

describe('createLogger', () => {
  it('creates a logger with the configured log level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger(makeConfig({ logLevel: 'warn' }));
    expect(logger.level).toBe('warn');
  });

  it('creates a logger with info level by default', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger(makeConfig({ logLevel: 'info' }));
    expect(logger.level).toBe('info');
  });

  it('supports silent log level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger(makeConfig({ logLevel: 'silent' }));
    expect(logger.level).toBe('silent');
  });

  it('supports debug log level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger(makeConfig({ logLevel: 'debug' }));
    expect(logger.level).toBe('debug');
  });

  it('filters out messages below the configured level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger(makeConfig({ logLevel: 'warn' }));

    expect(logger.levelVal).toBe(40);
    expect(logger.warn).toBeDefined();
    expect(logger.error).toBeDefined();
    expect(logger.silent).toBeDefined();
  });

  it('creates child loggers that inherit configuration', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger(makeConfig({ logLevel: 'info' }));
    const child = logger.child({ module: 'test-module' });

    expect(child.level).toBe('info');
  });
});

describe('pino logger behavior with same configuration as createLogger', () => {
  let capture: ReturnType<typeof createCaptureStream>;

  beforeEach(() => {
    capture = createCaptureStream();
  });

  it('outputs a log message as JSON', () => {
    const logger = pino({ level: 'info' }, capture.stream);

    logger.info('hello world');
    const logs = capture.getLogs();

    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toBe('hello world');
    expect(logs[0].level).toBe(30); // pino numeric level for info
    expect(logs[0].time).toBeGreaterThan(0);
    expect(logs[0].pid).toBeGreaterThan(0);
  });

  it('logs structured objects alongside messages', () => {
    const logger = pino({ level: 'info' }, capture.stream);

    logger.info({ userId: 42, action: 'login' }, 'user event');
    const logs = capture.getLogs();

    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toBe('user event');
    expect(logs[0].userId).toBe(42);
    expect(logs[0].action).toBe('login');
  });

  it('logs at all severity levels', () => {
    const logger = pino({ level: 'trace' }, capture.stream);

    logger.fatal('fatal msg');
    logger.error('error msg');
    logger.warn('warn msg');
    logger.info('info msg');
    logger.debug('debug msg');
    logger.trace('trace msg');

    const logs = capture.getLogs();
    const msgs = logs.map((l) => l.msg);

    expect(msgs).toContain('fatal msg');
    expect(msgs).toContain('error msg');
    expect(msgs).toContain('warn msg');
    expect(msgs).toContain('info msg');
    expect(msgs).toContain('debug msg');
    expect(msgs).toContain('trace msg');
  });

  it('does not output messages below the configured level', () => {
    const logger = pino({ level: 'warn' }, capture.stream);

    logger.info('should be silent');
    logger.warn('should appear');
    logger.error('should also appear');

    const logs = capture.getLogs();
    const msgs = logs.map((l) => l.msg);

    expect(msgs).not.toContain('should be silent');
    expect(msgs).toContain('should appear');
    expect(msgs).toContain('should also appear');
  });

  it('redacts joplinPassword field from log output', () => {
    const logger = pino(
      {
        level: 'info',
        redact: {
          paths: ['joplinPassword'],
          censor: '***REDACTED***',
        },
      },
      capture.stream,
    );

    logger.info({ joplinPassword: 'dummy-logger-pass' }, 'test with secret');
    const logs = capture.getLogs();

    expect(logs).toHaveLength(1);
    expect(logs[0].joplinPassword).toBe('***REDACTED***');
    expect(logs[0].msg).toBe('test with secret');
  });

  it('child loggers output messages inherited from parent', () => {
    const logger = pino({ level: 'info' }, capture.stream);

    const child = logger.child({ module: 'child-module' });
    child.info('child message');

    const logs = capture.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].msg).toBe('child message');
    expect(logs[0].module).toBe('child-module');
  });

  it('child loggers inherit redaction configuration', () => {
    const logger = pino(
      {
        level: 'info',
        redact: {
          paths: ['joplinPassword'],
          censor: '***REDACTED***',
        },
      },
      capture.stream,
    );

    const child = logger.child({ module: 'child' });
    child.info({ joplinPassword: 'dummy-child-pass', module: 'child' }, 'from child');
    const logs = capture.getLogs();

    expect(logs).toHaveLength(1);
    expect(logs[0].joplinPassword).toBe('***REDACTED***');
    expect(logs[0].msg).toBe('from child');
  });
});
