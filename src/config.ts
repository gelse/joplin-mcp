import { z } from 'zod';
import { GuardedString } from './guarded-string.js';
import { ConfigError } from './errors.js';

const configSchema = z.object({
  joplinServerUrl: z
    .string()
    .url()
    .describe('JOPLIN_SERVER_URL')
    .refine(
      (url) => {
        if (process.env['NODE_ENV'] === 'production') {
          return url.startsWith('https://');
        }
        return true;
      },
      { message: 'In production, JOPLIN_SERVER_URL must use HTTPS' },
    ),
  joplinUsername: z.string().min(1).describe('JOPLIN_USERNAME'),
  joplinPassword: z
    .string()
    .min(1)
    .describe('JOPLIN_PASSWORD')
    .transform((val) => new GuardedString(val)),
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
        `  JOPLIN_SERVER_URL (required)\n` +
        `  JOPLIN_USERNAME (required)\n` +
        `  JOPLIN_PASSWORD (required)\n` +
        `  JOPLIN_API_TOKEN (required — run "joplin config api.token" to get it)\n` +
        `  JOPLIN_DATA_API_PORT (optional, default: 41184)\n` +
        `  LOG_LEVEL (optional, default: "info")\n` +
        `  SYNC_INTERVAL_SECONDS (optional, default: 300)`,
    );
  }

  return result.data;
}
