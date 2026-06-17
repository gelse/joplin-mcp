import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from './logger.js';

const execFileAsync = promisify(execFile);

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly result: CliResult,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * Whitelist of allowed Joplin CLI subcommands.
 * This is a defense-in-depth measure against command injection.
 */
const ALLOWED_SUBCOMMANDS = new Set([
  'help',
  'version',
  'sync',
  'config',
  'status',
  'use',
  'ls',
  'cat',
  'rm',
  'mv',
  'cp',
  'mkbook',
  'rmbook',
  'tag',
  'untag',
  'ren',
  'set',
  'get',
  'export',
  'import',
  'server',
]);

/**
 * Characters that are forbidden in CLI arguments to prevent shell injection.
 * While execFile does not spawn a shell, this is defense-in-depth.
 */
const SHELL_METACHARACTERS = /[;|&$`(){}<>\n`]/;

export class CliExecutor {
  constructor(private readonly logger: Logger) {}

  /**
   * Validates CLI arguments against the whitelist and blocks shell metacharacters.
   * This is a defense-in-depth measure since execFile does not invoke a shell,
   * but still guards against unexpected behavior.
   */
  private validateArgs(args: string[]): void {
    if (args.length === 0) {
      throw new CliError('CLI args validation failed: no subcommand provided', {
        stdout: '',
        stderr: '',
        exitCode: 1,
      });
    }
    if (!ALLOWED_SUBCOMMANDS.has(args[0])) {
      throw new CliError(
        `CLI args validation failed: unknown subcommand "${args[0]}"` +
          ` — allowed subcommands: ${[...ALLOWED_SUBCOMMANDS].sort().join(', ')}`,
        { stdout: '', stderr: '', exitCode: 1 },
      );
    }
    for (const arg of args) {
      if (SHELL_METACHARACTERS.test(arg)) {
        throw new CliError(
          `CLI args validation failed: argument contains forbidden shell metacharacters: "${arg}"`,
          { stdout: '', stderr: '', exitCode: 1 },
        );
      }
    }
  }

  /**
   * Execute a Joplin CLI subcommand with argument validation.
   *
   * Validates arguments against the allowed-subcommand whitelist and blocks shell
   * metacharacters before executing via `execFile`. Throws a `CliError` on non-zero
   * exit codes or timeouts.
   *
   * @param args - CLI arguments; the first element must be an allowed subcommand (e.g. `['sync']`)
   * @param timeoutMs - Timeout in milliseconds (default: 60,000)
   * @returns A `CliResult` containing trimmed stdout, stderr, and exit code
   * @throws {CliError} If the subcommand is not in the allowed list, arguments contain
   *                    shell metacharacters, the process times out, or the exit code is non-zero
   */
  async exec(args: string[], timeoutMs: number = 60_000): Promise<CliResult> {
    this.validateArgs(args);

    const cmd = ['joplin', ...args];
    this.logger.debug({ args }, 'Executing joplin CLI command');

    try {
      const { stdout, stderr } = await execFileAsync('joplin', args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { PATH: process.env['PATH'], HOME: process.env['HOME'] },
      });

      const result: CliResult = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
      };

      if (result.stderr) {
        this.logger.warn({ stderr: result.stderr }, 'joplin CLI stderr output');
      }

      return result;
    } catch (error: unknown) {
      const execError = error as {
        code?: string;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      const result: CliResult = {
        stdout: (execError.stdout ?? '').trim(),
        stderr: (execError.stderr ?? '').trim(),
        exitCode: 1,
      };

      if (execError.killed) {
        this.logger.error({ args }, 'joplin CLI command timed out');
        throw new CliError(`joplin CLI timed out after ${timeoutMs}ms`, result);
      }

      this.logger.error(
        { args, stderr: result.stderr, code: execError.code },
        'joplin CLI command failed',
      );
      throw new CliError(`joplin CLI failed: ${execError.message ?? 'unknown error'}`, result);
    }
  }

  /**
   * Run `joplin sync` to synchronise with Joplin Server.
   *
   * Delegates to `exec(['sync'])` and logs a warning if the stderr output contains
   * conflict markers (remote-wins resolution).
   *
   * @throws {CliError} If the sync subprocess fails or times out
   */
  async sync(): Promise<void> {
    this.logger.info('Starting sync with Joplin Server');
    const result = await this.exec(['sync']);
    this.logger.info('Sync completed');

    // Check for conflicts in stderr
    if (result.stderr.toLowerCase().includes('conflict')) {
      this.logger.warn('Sync conflicts detected — remote version retained');
    }
  }

  /**
   * Check for conflict notes by running `joplin ls --conflict`.
   *
   * @returns The number of conflict notes currently present
   * @throws {CliError} If the conflict-check subprocess fails or times out
   */
  async checkConflicts(): Promise<number> {
    const result = await this.exec(['ls', '--conflict']);
    const lines = result.stdout.split('\n').filter((l) => l.trim());
    return lines.length;
  }
}
