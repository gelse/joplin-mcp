import { pino } from 'pino';
import type { Config } from './config.js';

const SECRETS: string[] = [
  'joplinPassword',
  'joplinUsername',
  'joplinServerUrl',
  'config.joplinUsername',
  'config.joplinServerUrl',
];

export function createLogger(config: Config) {
  return pino({
    level: config.logLevel,
    redact: {
      paths: SECRETS,
      censor: '***REDACTED***',
    },
    transport:
      config.logLevel === 'debug'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
