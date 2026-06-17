import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ENV_VARS = [
  'JOPLIN_SERVER_URL',
  'JOPLIN_USERNAME',
  'JOPLIN_PASSWORD',
  'JOPLIN_API_TOKEN',
  'JOPLIN_DATA_API_PORT',
  'LOG_LEVEL',
  'SYNC_INTERVAL_SECONDS',
] as const;

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_VARS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const key of ENV_VARS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

describe('Config Parser', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = saveEnv();
    for (const key of ENV_VARS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  it('should throw when required env vars are missing', async () => {
    // Re-import to get fresh module with cleared env
    const { parseConfig } = await import('../src/config.js');
    expect(() => parseConfig()).toThrow('Configuration validation failed');
  });

  it('should parse valid config with defaults', async () => {
    process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
    process.env['JOPLIN_USERNAME'] = 'test@example.com';
    process.env['JOPLIN_PASSWORD'] = 'dummy-password';
    process.env['JOPLIN_API_TOKEN'] = 'test-api-token-12345';

    const { parseConfig } = await import('../src/config.js');
    const config = parseConfig();

    expect(config.joplinServerUrl).toBe('https://joplin.example.com/');
    expect(config.joplinUsername).toBe('test@example.com');
    expect(config.dataApiPort).toBe(41100);
    expect(config.logLevel).toBe('info');
    expect(config.syncIntervalSeconds).toBe(300);
  });

  it('should use custom port and settings', async () => {
    process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
    process.env['JOPLIN_USERNAME'] = 'test@example.com';
    process.env['JOPLIN_PASSWORD'] = 'dummy-password';
    process.env['JOPLIN_API_TOKEN'] = 'test-api-token-12345';
    process.env['JOPLIN_DATA_API_PORT'] = '12345';
    process.env['LOG_LEVEL'] = 'debug';
    process.env['SYNC_INTERVAL_SECONDS'] = '120';

    const { parseConfig } = await import('../src/config.js');
    const config = parseConfig();

    expect(config.dataApiPort).toBe(12345);
    expect(config.logLevel).toBe('debug');
    expect(config.syncIntervalSeconds).toBe(120);
  });
  describe('boundary values', () => {
    it('should reject malformed URL for joplinServerUrl', async () => {
      process.env['JOPLIN_SERVER_URL'] = 'not-a-valid-url';
      process.env['JOPLIN_USERNAME'] = 'test@example.com';
      process.env['JOPLIN_PASSWORD'] = 'dummy-password';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should reject empty string for joplinServerUrl', async () => {
      process.env['JOPLIN_SERVER_URL'] = '';
      process.env['JOPLIN_USERNAME'] = 'test@example.com';
      process.env['JOPLIN_PASSWORD'] = 'dummy-password';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should reject empty string for joplinUsername', async () => {
      process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
      process.env['JOPLIN_USERNAME'] = '';
      process.env['JOPLIN_PASSWORD'] = 'dummy-password';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should reject empty string for joplinPassword', async () => {
      process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
      process.env['JOPLIN_USERNAME'] = 'test@example.com';
      process.env['JOPLIN_PASSWORD'] = '';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should reject negative port value', async () => {
      process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
      process.env['JOPLIN_USERNAME'] = 'test@example.com';
      process.env['JOPLIN_PASSWORD'] = 'dummy-password';
      process.env['JOPLIN_DATA_API_PORT'] = '-1';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should reject zero port value', async () => {
      process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
      process.env['JOPLIN_USERNAME'] = 'test@example.com';
      process.env['JOPLIN_PASSWORD'] = 'dummy-password';
      process.env['JOPLIN_DATA_API_PORT'] = '0';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should reject port value exceeding 65535', async () => {
      process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
      process.env['JOPLIN_USERNAME'] = 'test@example.com';
      process.env['JOPLIN_PASSWORD'] = 'dummy-password';
      process.env['JOPLIN_DATA_API_PORT'] = '99999';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should reject non-numeric port value', async () => {
      process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
      process.env['JOPLIN_USERNAME'] = 'test@example.com';
      process.env['JOPLIN_PASSWORD'] = 'dummy-password';
      process.env['JOPLIN_DATA_API_PORT'] = 'abc';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should reject invalid log level', async () => {
      process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
      process.env['JOPLIN_USERNAME'] = 'test@example.com';
      process.env['JOPLIN_PASSWORD'] = 'dummy-password';
      process.env['LOG_LEVEL'] = 'invalid-level';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should reject negative sync interval', async () => {
      process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
      process.env['JOPLIN_USERNAME'] = 'test@example.com';
      process.env['JOPLIN_PASSWORD'] = 'dummy-password';
      process.env['SYNC_INTERVAL_SECONDS'] = '-10';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should reject HTTP URL in production mode', async () => {
      process.env['NODE_ENV'] = 'production';
      process.env['JOPLIN_SERVER_URL'] = 'http://joplin.example.com/';
      process.env['JOPLIN_USERNAME'] = 'test@example.com';
      process.env['JOPLIN_PASSWORD'] = 'dummy-password';

      const { parseConfig } = await import('../src/config.js');
      expect(() => parseConfig()).toThrow('Configuration validation failed');
    });

    it('should accept HTTPS URL in production mode', async () => {
        process.env['NODE_ENV'] = 'production';
        process.env['JOPLIN_SERVER_URL'] = 'https://joplin.example.com/';
        process.env['JOPLIN_USERNAME'] = 'test@example.com';
        process.env['JOPLIN_PASSWORD'] = 'dummy-password';
        process.env['JOPLIN_API_TOKEN'] = 'test-api-token-12345';

      const { parseConfig } = await import('../src/config.js');
      const config = parseConfig();
      expect(config.joplinServerUrl).toBe('https://joplin.example.com/');
    });
  });
});
