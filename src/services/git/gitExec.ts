import { spawn } from 'node:child_process';

import { createLogger } from '@/lib/logging/logger';
import { assertArgsAllowed } from '@/services/git/guards';

const log = createLogger('git');

/**
 * Safe git process execution.
 *
 * Three deliberate properties:
 *
 *  - `spawn` with an argv array and `shell: false`, so no value is ever parsed
 *    by a shell. Branch names and commit messages come from Azure DevOps and
 *    must never be interpolated into a command string.
 *  - The PAT is passed only through the child's environment, read by the
 *    GIT_ASKPASS helper. It never appears in argv (visible to other processes)
 *    nor in a remote URL (persisted into .git/config).
 *  - Every invocation is checked by the guards first, so a force push or a write
 *    to a release branch fails before a process exists.
 */

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Reconstructed for logs only; never executed as a string. */
  command: string;
  durationMs: number;
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly result: GitResult,
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export interface GitExecOptions {
  cwd: string;
  /** PAT supplied to GIT_ASKPASS. Omit for operations that need no auth. */
  pat?: string;
  askPassPath?: string;
  /** Identity for commits this invocation may create. */
  committer?: { name: string; email: string };
  /** CA bundle for HTTPS. Git uses schannel on Windows and usually needs none. */
  caBundlePath?: string;
  timeoutMs?: number;
  /** Treat a non-zero exit as a value rather than throwing. */
  allowFailure?: boolean;
  allowedPrefixes?: readonly string[];
}

export class Git {
  constructor(private readonly executable: string) {}

  /**
   * Runs git and returns the result.
   *
   * `-c` options are prepended rather than relying on repository or global
   * config, so behaviour does not depend on the developer's machine. In
   * particular the committer identity is always explicit and the credential
   * helper is disabled to stop a GUI prompt blocking a background job.
   */
  async run(args: readonly string[], options: GitExecOptions): Promise<GitResult> {
    assertArgsAllowed(args, { allowedPrefixes: options.allowedPrefixes });

    const configArgs: string[] = [
      // No interactive credential prompts: a blocked job would hang forever.
      '-c',
      'credential.helper=',
      // Deterministic behaviour regardless of the user's global config.
      '-c',
      'core.autocrlf=false',
      '-c',
      'advice.detachedHead=false',
    ];

    if (options.committer) {
      configArgs.push(
        '-c',
        `user.name=${options.committer.name}`,
        '-c',
        `user.email=${options.committer.email}`,
      );
    }

    if (options.caBundlePath) {
      configArgs.push('-c', `http.sslCAInfo=${options.caBundlePath}`);
    }

    const finalArgs = [...configArgs, ...args];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Fail instead of prompting if askpass is unavailable.
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      // Stable, parseable output.
      LC_ALL: 'C',
      GIT_PAGER: 'cat',
    };

    if (options.pat && options.askPassPath) {
      env.GIT_PAT = options.pat;
      env.GIT_ASKPASS = options.askPassPath;
    }

    // Logged without the config preamble, and never with the environment.
    const command = `git ${args.join(' ')}`;
    const startedAt = Date.now();

    return new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.executable, finalArgs, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(
            new GitCommandError(`git timed out after ${options.timeoutMs ?? 300_000}ms: ${command}`, {
              stdout,
              stderr,
              exitCode: -1,
              command,
              durationMs: Date.now() - startedAt,
            }),
          );
        },
        options.timeoutMs ?? 300_000,
      );

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(
          new GitCommandError(
            `Could not start git at "${this.executable}": ${error.message}. ` +
              'Check the Git executable path in settings.',
            { stdout, stderr, exitCode: -1, command, durationMs: Date.now() - startedAt },
          ),
        );
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        const result: GitResult = {
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          exitCode: code ?? -1,
          command,
          durationMs: Date.now() - startedAt,
        };

        log.debug('git finished', {
          command,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });

        if (result.exitCode !== 0 && !options.allowFailure) {
          reject(
            new GitCommandError(
              `${command} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
              result,
            ),
          );
          return;
        }

        resolve(result);
      });
    });
  }

  /** Convenience for reads where a non-zero exit is meaningful, not fatal. */
  async tryRun(args: readonly string[], options: GitExecOptions): Promise<GitResult> {
    return this.run(args, { ...options, allowFailure: true });
  }

  async version(cwd: string): Promise<string> {
    const result = await this.run(['--version'], { cwd });
    return result.stdout.trim();
  }
}
