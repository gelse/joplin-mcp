import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly result: CliResult
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class CliExecutor {
  constructor(private readonly logger: Logger) {}

  async exec(args: string[], timeoutMs: number = 60_000): Promise<CliResult> {
    const cmd = ["joplin", ...args];
    this.logger.debug({ args }, "Executing joplin CLI command");

    try {
      const { stdout, stderr } = await execFileAsync("joplin", args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HOME: process.env["HOME"] },
      });

      const result: CliResult = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
      };

      if (result.stderr) {
        this.logger.warn({ stderr: result.stderr }, "joplin CLI stderr output");
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
        stdout: (execError.stdout ?? "").trim(),
        stderr: (execError.stderr ?? "").trim(),
        exitCode: 1,
      };

      if (execError.killed) {
        this.logger.error({ args }, "joplin CLI command timed out");
        throw new CliError(`joplin CLI timed out after ${timeoutMs}ms`, result);
      }

      this.logger.error(
        { args, stderr: result.stderr, code: execError.code },
        "joplin CLI command failed"
      );
      throw new CliError(
        `joplin CLI failed: ${execError.message ?? "unknown error"}`,
        result
      );
    }
  }

  async sync(): Promise<void> {
    this.logger.info("Starting sync with Joplin Server");
    const result = await this.exec(["sync"]);
    this.logger.info("Sync completed");

    // Check for conflicts in stderr
    if (result.stderr.toLowerCase().includes("conflict")) {
      this.logger.warn("Sync conflicts detected — remote version retained");
    }
  }

  async checkConflicts(): Promise<number> {
    const result = await this.exec(["ls", "--conflict"]);
    const lines = result.stdout.split("\n").filter((l) => l.trim());
    return lines.length;
  }
}
