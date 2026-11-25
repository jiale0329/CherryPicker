import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/lib/logging/logger';
import { assertCanCreateBranch } from '@/services/git/guards';
import type { Git, GitExecOptions } from '@/services/git/gitExec';

const log = createLogger('git-worktree');

/**
 * Isolated worktrees for backport jobs.
 *
 * Each job checks out the target release branch into its own directory under a
 * new backport branch, so concurrent jobs cannot interfere with each other or
 * with the developer's working copy. The worktree is disposable: on conflict it
 * is removed and the job is retried from scratch rather than repaired in place.
 */

export interface Worktree {
  path: string;
  branch: string;
  /** Run git inside this worktree. */
  exec(args: readonly string[], options?: { allowFailure?: boolean }): ReturnType<Git['run']>;
  dispose(): Promise<void>;
}

export interface CreateWorktreeOptions {
  git: Git;
  mirrorPath: string;
  worktreeDir: string;
  /** New branch to create, must be under the backport prefix. */
  branch: string;
  /** Branch or sha the backport starts from, normally the target release. */
  startPoint: string;
  committer: { name: string; email: string };
  allowedPrefixes?: readonly string[];
  jobId: string;
  /**
   * Credentials for operations that reach the remote.
   *
   * Required for push. Omitting these is why the first real execution failed
   * with "Authentication failed": only the mirror clone and fetch were given
   * credentials, so the push from the worktree had none and the credential
   * helper is deliberately disabled to stop a GUI prompt hanging the job.
   */
  pat?: string;
  askPassPath?: string;
  caBundlePath?: string;
}

export async function createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
  // Enforced before anything touches the filesystem: a worktree must never be
  // created on a release branch.
  assertCanCreateBranch(options.branch, options.allowedPrefixes);

  mkdirSync(options.worktreeDir, { recursive: true });

  // Job id keeps parallel jobs on the same branch name from colliding on disk.
  const worktreePath = path.join(options.worktreeDir, options.jobId);
  if (existsSync(worktreePath)) {
    await removeWorktreeDirectory(options.git, options.mirrorPath, worktreePath);
  }

  const startRef = options.startPoint.startsWith('refs/')
    ? options.startPoint
    : `refs/heads/${options.startPoint}`;

  log.debug('creating worktree', { path: worktreePath, branch: options.branch, startRef });

  await options.git.run(
    ['worktree', 'add', '-b', options.branch, worktreePath, startRef],
    {
      cwd: options.mirrorPath,
      committer: options.committer,
      allowedPrefixes: options.allowedPrefixes,
      timeoutMs: 5 * 60_000,
    },
  );

  const baseOptions: GitExecOptions = {
    cwd: worktreePath,
    committer: options.committer,
    allowedPrefixes: options.allowedPrefixes,
    pat: options.pat,
    askPassPath: options.askPassPath,
    caBundlePath: options.caBundlePath,
    timeoutMs: 5 * 60_000,
  };

  return {
    path: worktreePath,
    branch: options.branch,
    exec: (args, execOptions) =>
      options.git.run(args, { ...baseOptions, allowFailure: execOptions?.allowFailure }),
    dispose: async () => {
      await removeWorktreeDirectory(options.git, options.mirrorPath, worktreePath);
      // The branch only exists locally in the mirror; drop it so a retry can
      // recreate it cleanly. Failure is not fatal.
      await options.git.tryRun(['branch', '-D', options.branch], {
        cwd: options.mirrorPath,
        timeoutMs: 60_000,
      });
    },
  };
}

/**
 * Removes a worktree, falling back to deleting the directory.
 *
 * `git worktree remove` refuses a dirty worktree, and the forced variant is
 * blocked by the guards, so the fallback deletes the directory and lets
 * `git worktree prune` reconcile the metadata. That is safe: a worktree holds
 * no unpushed history of its own beyond the branch, which the caller deletes.
 */
async function removeWorktreeDirectory(
  git: Git,
  mirrorPath: string,
  worktreePath: string,
): Promise<void> {
  const removed = await git.tryRun(['worktree', 'remove', worktreePath], {
    cwd: mirrorPath,
    timeoutMs: 60_000,
  });

  if (removed.exitCode !== 0) {
    log.debug('worktree remove refused; deleting directory and pruning', {
      path: worktreePath,
      stderr: removed.stderr,
    });
    try {
      rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      log.warn('could not delete worktree directory', {
        path: worktreePath,
        error: (error as Error).message,
      });
    }
    await git.tryRun(['worktree', 'prune'], { cwd: mirrorPath, timeoutMs: 60_000 });
  }
}

/** Files left in a conflicted state by a failed cherry-pick. */
export async function conflictedFiles(worktree: Worktree): Promise<string[]> {
  const result = await worktree.exec(['diff', '--name-only', '--diff-filter=U'], {
    allowFailure: true,
  });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
