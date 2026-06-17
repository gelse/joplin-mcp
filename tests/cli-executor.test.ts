import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliExecutor, CliError } from '../src/cli-executor.js';
import type { Logger } from '../src/logger.js';

// ── Mocks ──────────────────────────────────────────────────────────────

type ExecFileCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

const mockExecFile = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: object,
      callback: ExecFileCallback,
    ) => { unref?: () => void }
  >(),
);

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

// Logger stub
const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: 'silent',
} as unknown as Logger;

// ── Helpers ────────────────────────────────────────────────────────────

/** Simulate a successful execFile call with the given stdout/stderr. */
function mockSuccess(stdout = 'ok', stderr = '') {
  mockExecFile.mockImplementationOnce((_f, _a, _o, cb) => {
    cb(null, { stdout, stderr });
    return {};
  });
}

/** Simulate a failed execFile call — error on the callback. */
function mockFailure(
  overrides: {
    message?: string;
    code?: string | number;
    killed?: boolean;
    stdout?: string;
    stderr?: string;
  } = {},
) {
  const err = new Error(overrides.message ?? 'command failed') as Error & {
    code?: string | number;
    killed?: boolean;
    stdout?: string;
    stderr?: string;
  };
  err.code = overrides.code ?? 1;
  err.killed = overrides.killed ?? false;
  err.stdout = overrides.stdout ?? '';
  err.stderr = overrides.stderr ?? 'error output';
  mockExecFile.mockImplementationOnce((_f, _a, _o, cb) => {
    cb(err, { stdout: err.stdout ?? '', stderr: err.stderr ?? '' });
    return {};
  });
}

// ── Suite ──────────────────────────────────────────────────────────────

describe('CliExecutor', () => {
  let executor: CliExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new CliExecutor(mockLogger);
  });

  // ── 1. Successful execution ─────────────────────────────────────────

  describe('exec (success)', () => {
    it('spawns joplin CLI and resolves with trimmed stdout/stderr', async () => {
      mockSuccess('  result line 1\n  result line 2  ', '  warnings  ');

      const result = await executor.exec(['sync']);

      expect(mockExecFile).toHaveBeenCalledWith(
        'joplin',
        ['sync'],
        expect.objectContaining({
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        }),
        expect.any(Function),
      );
      expect(result.stdout).toBe('result line 1\n  result line 2');
      expect(result.stderr).toBe('warnings');
      expect(result.exitCode).toBe(0);
    });

    it('passes custom timeout and args to execFile', async () => {
      mockSuccess();

      await executor.exec(['status', '--verbose'], 30_000);

      expect(mockExecFile).toHaveBeenCalledWith(
        'joplin',
        ['status', '--verbose'],
        expect.objectContaining({ timeout: 30_000 }),
        expect.any(Function),
      );
    });

    it('logs a warning when stderr contains output', async () => {
      mockSuccess('stdout content', 'non-empty stderr');

      await executor.exec(['sync']);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ stderr: 'non-empty stderr' }),
        expect.stringContaining('stderr'),
      );
    });
  });

  // ── 2. Failed execution (non-zero exit) ─────────────────────────────

  describe('exec (failure)', () => {
    it('throws CliError when child process exits with non-zero code', async () => {
      mockFailure({ stderr: 'FATAL: something went wrong' });

      await expect(executor.exec(['sync'])).rejects.toThrow(CliError);
    });

    it('includes stderr content in the error result', async () => {
      mockFailure({ stderr: 'error details' });

      try {
        await executor.exec(['sync']);
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        const cliErr = e as CliError;
        expect(cliErr.result.stderr).toBe('error details');
        expect(cliErr.result.exitCode).toBe(1);
      }
    });
  });

  // ── 3. Timeout ──────────────────────────────────────────────────────

  describe('exec (timeout)', () => {
    it('throws CliError with timeout message when process is killed', async () => {
      mockFailure({ killed: true, message: 'timed out' });

      try {
        await executor.exec(['sync'], 5_000);
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CliError);
        const cliErr = e as CliError;
        expect(cliErr.message).toContain('timed out after 5000ms');
        expect(cliErr.message).toContain('5000');
      }
    });
  });

  // ── 4. Stderr capture ───────────────────────────────────────────────

  describe('stderr capture', () => {
    it('captures stderr separately from stdout in the CliResult', async () => {
      mockFailure({
        stdout: 'stdout content',
        stderr: 'stderr content',
      });

      try {
        await executor.exec(['export']);
        expect.unreachable('Should have thrown');
      } catch (e) {
        const cliErr = e as CliError;
        expect(cliErr.result.stdout).toBe('stdout content');
        expect(cliErr.result.stderr).toBe('stderr content');
      }
    });

    it('trims stderr in the CliResult', async () => {
      mockFailure({
        stdout: '',
        stderr: '  trailing spaces  ',
      });

      try {
        await executor.exec(['export']);
        expect.unreachable('Should have thrown');
      } catch (e) {
        const cliErr = e as CliError;
        expect(cliErr.result.stderr).toBe('trailing spaces');
      }
    });
  });

  // ── 5. Sync command ─────────────────────────────────────────────────

  describe('sync()', () => {
    it('calls exec with the sync argument', async () => {
      mockSuccess();

      await executor.sync();

      expect(mockExecFile).toHaveBeenCalledWith(
        'joplin',
        ['sync'],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('resolves without error on successful sync', async () => {
      mockSuccess('Sync completed');

      await expect(executor.sync()).resolves.toBeUndefined();
    });

    it('re-throws CliError when underlying exec fails', async () => {
      mockFailure({ stderr: 'auth error' });

      await expect(executor.sync()).rejects.toThrow(CliError);
    });
  });

  // ── 6. Conflict detection ───────────────────────────────────────────

  describe('conflict detection in sync()', () => {
    it('logs a warning when stderr contains "conflict"', async () => {
      mockSuccess('done', 'There are 3 conflicts found');

      await executor.sync();

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('conflict'));
    });

    it('does not log conflict warning when stderr is clean', async () => {
      mockSuccess('done', '');

      await executor.sync();

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('is case-insensitive when detecting conflict in stderr', async () => {
      mockSuccess('done', 'CONFLICT detected');

      await executor.sync();

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('conflict'));
    });
  });

  // ── 6b. checkConflicts() ────────────────────────────────────────────

  describe('checkConflicts()', () => {
    it('calls exec with ls --conflict and returns conflict count', async () => {
      mockSuccess('note1\nnote2\nnote3');

      const count = await executor.checkConflicts();

      expect(mockExecFile).toHaveBeenCalledWith(
        'joplin',
        ['ls', '--conflict'],
        expect.any(Object),
        expect.any(Function),
      );
      expect(count).toBe(3);
    });

    it('returns 0 when stdout is empty', async () => {
      mockSuccess('');

      const count = await executor.checkConflicts();
      expect(count).toBe(0);
    });

    it('filters empty lines from the output', async () => {
      mockSuccess('\n\nnote1\n\nnote2\n\n');

      const count = await executor.checkConflicts();
      expect(count).toBe(2);
    });
  });

  // ── 7. Argument handling ────────────────────────────────────────────

  describe('argument forwarding', () => {
    it('passes arguments with spaces correctly through execFile', async () => {
      mockSuccess();

      await executor.exec(['export', '--path', '/some/path with spaces']);

      expect(mockExecFile).toHaveBeenCalledWith(
        'joplin',
        ['export', '--path', '/some/path with spaces'],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it('passes multiple mixed arguments in order', async () => {
      mockSuccess();

      await executor.exec(['ls', '--conflict', '--limit', '50', '--format', 'json']);

      expect(mockExecFile).toHaveBeenCalledWith(
        'joplin',
        ['ls', '--conflict', '--limit', '50', '--format', 'json'],
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  // ── 8. Shell metacharacter validation ───────────────────────────────

  describe('shell metacharacter validation', () => {
    it('rejects arguments containing a semicolon', async () => {
      await expect(executor.exec(['sync', '; rm -rf /'])).rejects.toThrow(CliError);
    });

    it('rejects arguments containing a pipe', async () => {
      await expect(executor.exec(['sync', '| cat /etc/passwd'])).rejects.toThrow(CliError);
    });

    it('rejects arguments containing an ampersand', async () => {
      await expect(executor.exec(['sync', '& echo pwned'])).rejects.toThrow(CliError);
    });

    it('rejects arguments containing a backtick', async () => {
      await expect(executor.exec(['sync', '`id`'])).rejects.toThrow(CliError);
    });

    it('rejects arguments containing dollar-parenthesis', async () => {
      await expect(executor.exec(['sync', '$(whoami)'])).rejects.toThrow(CliError);
    });

    it('rejects arguments containing a subprocess execution pattern', async () => {
      await expect(executor.exec(['sync', '$(echo hi)'])).rejects.toThrow(CliError);
    });

    it('rejects arguments containing output redirection', async () => {
      await expect(executor.exec(['sync', '> /dev/null'])).rejects.toThrow(CliError);
    });

    it('rejects arguments containing a newline', async () => {
      await expect(executor.exec(['sync', 'ls\n'])).rejects.toThrow(CliError);
    });

    it('rejects the first argument when it contains shell metacharacters', async () => {
      await expect(executor.exec([';ls'])).rejects.toThrow(CliError);
    });

    it('includes the dangerous argument in the error message', async () => {
      try {
        await executor.exec(['sync', '$(pwd)']);
        expect.unreachable('Should have thrown');
      } catch (e) {
        const cliErr = e as CliError;
        expect(cliErr.message).toContain('$(pwd)');
      }
    });

    it('allows safe arguments with special characters in the middle of words', async () => {
      mockSuccess();
      await expect(
        executor.exec(['export', '--path', '/safe/path/with-dashes_and_underscores']),
      ).resolves.toBeDefined();
    });
  });

  // ── 9. Error result structure ───────────────────────────────────────

  describe('CliError result structure', () => {
    it('wraps the full result in the thrown CliError', async () => {
      mockFailure({
        stdout: 'some stdout',
        stderr: 'some stderr',
      });

      try {
        await executor.exec(['help']);
        expect.unreachable('Should have thrown');
      } catch (e) {
        const cliErr = e as CliError;
        expect(cliErr.name).toBe('CliError');
        expect(cliErr.result).toEqual({
          stdout: 'some stdout',
          stderr: 'some stderr',
          exitCode: 1,
        });
      }
    });

    it('uses empty strings when error has no stdout/stderr', async () => {
      mockFailure({ stdout: '', stderr: '' });

      try {
        await executor.exec(['help']);
        expect.unreachable('Should have thrown');
      } catch (e) {
        const cliErr = e as CliError;
        expect(cliErr.result.stdout).toBe('');
        expect(cliErr.result.stderr).toBe('');
      }
    });
  });
});
