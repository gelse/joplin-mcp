import { z } from 'zod';
import { GuardedString } from './guarded-string.js';
import { ConfigError } from './errors.js';

const configSchema = z.object({
  joplinServerUrl: z
    .string()
    .url()
    .optional()
    .describe('JOPLIN_SERVER_URL'),
  joplinUsername: z.string().min(1).optional().describe('JOPLIN_USERNAME'),
  joplinPassword: z
    .string()
    .min(1)
    .optional()
    .describe('JOPLIN_PASSWORD')
    .transform((val) => (val ? new GuardedString(val) : undefined)),
  dataApiPort: z.coerce
    .number()
    .int()
    .positive()
    .max(65535)
    .default(41184)
    .describe('JOPLIN_DATA_API_PORT'),
  joplinApiToken: z
    .string()
    .min(1)
    .describe('JOPLIN_API_TOKEN'),
  joplinCoreUrl: z
    .string()
    .url()
    .optional()
    .describe('JOPLIN_CORE_URL — URL of the joplin-core container Data API (Container B only)'),
  logLevel: z
    .enum(['debug', 'info', 'warn', 'error', 'silent'])
    .default('info')
    .describe('LOG_LEVEL'),
  syncIntervalSeconds: z.coerce
    .number()
    .int()
    .positive()
    .default(300)
    .describe('SYNC_INTERVAL_SECONDS'),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(): Config {
  const env = {
    joplinServerUrl: process.env['JOPLIN_SERVER_URL'],
    joplinUsername: process.env['JOPLIN_USERNAME'],
    joplinPassword: process.env['JOPLIN_PASSWORD'],
    dataApiPort: process.env['JOPLIN_DATA_API_PORT'],
    joplinApiToken: process.env['JOPLIN_API_TOKEN'],
    joplinCoreUrl: process.env['JOPLIN_CORE_URL'],
    logLevel: process.env['LOG_LEVEL'],
    syncIntervalSeconds: process.env['SYNC_INTERVAL_SECONDS'],
  };

  const result = configSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new ConfigError(
      `Configuration validation failed:\n${errors}\n\n` +
        `Ensure the following environment variables are set:\n` +
        `  JOPLIN_SERVER_URL (required for monolithic/Container A)\n` +
        `  JOPLIN_USERNAME (required for monolithic/Container A)\n` +
        `  JOPLIN_PASSWORD (required for monolithic/Container A)\n` +
        `  JOPLIN_API_TOKEN (required)\n` +
        `  JOPLIN_CORE_URL (required for Container B MCP server)\n` +
        `  JOPLIN_DATA_API_PORT (optional, default: 41184)\n` +
        `  LOG_LEVEL (optional, default: "info")\n` +
        `  SYNC_INTERVAL_SECONDS (optional, default: 300)`,
    );
  }

  return result.data;
}
