import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Git } from '@/services/git/gitExec';

/**
 * Builds throwaway git repositories on disk so the engine can be tested against
 * real git rather than a mock. No network and no ADO connection required.
 *
 * The git executable is resolved from GIT_EXECUTABLE when set, because `git` on
 * PATH is a zero-byte stub on the original development machine.
 */

export function resolveGitExecutable(): string {
  return process.env.GIT_EXECUTABLE?.trim() || 'git';
}

export const COMMITTER = { name: 'Backport Test', email: 'backport@test.invalid' } as const;

export class TempRepo {
  readonly git: Git;

  private constructor(readonly dir: string) {
    this.git = new Git(resolveGitExecutable());
  }

  static async create(prefix = 'rbm-test-'): Promise<TempRepo> {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    const repo = new TempRepo(dir);

    // `-b main` avoids depending on the machine's init.defaultBranch.
    await repo.run(['init', '-b', 'main']);
    // Commits must not depend on the developer's global config.
    await repo.run(['config', 'user.name', COMMITTER.name]);
    await repo.run(['config', 'user.email', COMMITTER.email]);
    await repo.run(['config', 'commit.gpgsign', 'false']);
    return repo;
  }

  run(args: readonly string[], options: { allowFailure?: boolean } = {}) {
    return this.git.run(args, {
      cwd: this.dir,
      committer: COMMITTER,
      allowFailure: options.allowFailure,
      timeoutMs: 30_000,
    });
  }

  tryRun(args: readonly string[]) {
    return this.run(args, { allowFailure: true });
  }

  write(file: string, contents: string): void {
    writeFileSync(path.join(this.dir, file), contents, 'utf8');
  }

  async commit(message: string, files: Record<string, string>): Promise<string> {
    for (const [file, contents] of Object.entries(files)) this.write(file, contents);
    await this.run(['add', '--all']);
    await this.run(['commit', '-m', message]);
    return this.head();
  }

  async head(): Promise<string> {
    const result = await this.run(['rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  async branch(name: string, startPoint?: string): Promise<void> {
    await this.run(startPoint ? ['branch', name, startPoint] : ['branch', name]);
  }

  async checkout(name: string): Promise<void> {
    await this.run(['checkout', name]);
  }

  async log(ref = 'HEAD'): Promise<string[]> {
    const result = await this.run(['log', ref, '--format=%s']);
    return result.stdout.trim().split('\n').filter(Boolean);
  }

  /**
   * Reads a file from the working tree.
   *
   * Deliberately not `git show`, because GitResult.stdout is trimmed - right
   * for parsing command output, wrong for file contents, where a trailing
   * newline is part of the data.
   */
  fileContents(file: string): string {
    return readFileSync(path.join(this.dir, file), 'utf8');
  }

  cleanup(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows occasionally holds a handle briefly; a leftover temp dir is
      // harmless and the OS will clear it.
    }
  }
}
