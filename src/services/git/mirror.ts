import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { createLogger } from '@/lib/logging/logger';
import type { Git, GitExecOptions } from '@/services/git/gitExec';

const log = createLogger('git-mirror');

/**
 * Local bare mirrors, one per repository.
 *
 * A mirror rather than a working clone, because every backport job gets its own
 * worktree from it. That keeps concurrent jobs isolated from each other and
 * from the developer's own checkout, which the brief requires.
 *
 * Mirrors are a cache: they can be deleted and will be recreated. All seven
 * tracked repositories together are roughly 1 GB, dominated by core-application
 * at 822 MB, so the first clone of that one is slow and worth doing before it is
 * needed rather than during a job.
 */

export interface MirrorContext {
  git: Git;
  mirrorDir: string;
  pat: string;
  askPassPath: string;
  caBundlePath?: string;
}

/**
 * Absolute path to a repository's mirror.
 *
 * Absolute deliberately. A relative mirror path combined with running git from
 * inside the mirror directory made git resolve it a second time, creating
 * `.repo-cache/.repo-cache/<repo>.git` and then failing the next run because
 * the directory "already exists". Resolving once, here, removes the ambiguity.
 */
export function mirrorPathFor(mirrorDir: string, repositoryName: string): string {
  // Repository names come from ADO and can contain characters that are awkward
  // in a path; only word characters, dash and dot are kept.
  const safe = repositoryName.replace(/[^\w.-]+/g, '_');
  return path.resolve(mirrorDir, `${safe}.git`);
}

/**
 * Clears `remote.origin.mirror`, which `clone --mirror` sets.
 *
 * With that flag set, git rejects any push that names a refspec:
 * "fatal: --mirror can't be combined with refspecs". A mirror remote means
 * "push every ref as-is", which is precisely what this tool must never do, so
 * the flag is removed and every push names an explicit backport refspec that
 * the guards have already validated.
 *
 * The fetch refspec (+refs/*:refs/*) is left intact, so the mirror still tracks
 * all refs on fetch.
 */
export async function disableMirrorPush(git: Git, mirrorPath: string): Promise<void> {
  const current = await git.tryRun(['config', '--get', 'remote.origin.mirror'], {
    cwd: mirrorPath,
    timeoutMs: 30_000,
  });
  if (current.exitCode !== 0 || current.stdout.trim() !== 'true') return;

  await git.tryRun(['config', '--unset', 'remote.origin.mirror'], {
    cwd: mirrorPath,
    timeoutMs: 30_000,
  });
  log.debug('cleared remote.origin.mirror so refspec pushes are possible', { mirrorPath });
}

/** A directory is only a usable mirror if git itself recognises it. */
async function isValidMirror(git: Git, mirrorPath: string): Promise<boolean> {
  if (!existsSync(path.join(mirrorPath, 'HEAD'))) return false;
  const result = await git.tryRun(['rev-parse', '--is-bare-repository'], {
    cwd: mirrorPath,
    timeoutMs: 30_000,
  });
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

/**
 * Serialises mirror preparation per repository.
 *
 * Two concurrent jobs on the same repository would otherwise both see a missing
 * mirror and race to clone it, which is how the nested-directory failure above
 * first surfaced.
 */
const inFlight = new Map<string, Promise<EnsureMirrorResult>>();

/** Remote URL with a non-secret username; the PAT arrives via GIT_ASKPASS. */
export function remoteUrlFor(orgUrl: string, project: string, repositoryName: string): string {
  const url = new URL(orgUrl);
  url.username = 'azdo';
  return `${url.toString().replace(/\/$/, '')}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repositoryName)}`;
}

export interface EnsureMirrorResult {
  mirrorPath: string
  created: boolean;
  durationMs: number;
}

/**
 * Creates the mirror if absent, otherwise fetches. Returns quickly when the
 * mirror is already current enough for the caller's purposes.
 */
export async function ensureMirror(
  context: MirrorContext,
  options: { repositoryName: string; orgUrl: string; project: string; skipFetch?: boolean },
): Promise<EnsureMirrorResult> {
  const mirrorPath = mirrorPathFor(context.mirrorDir, options.repositoryName);

  const existing = inFlight.get(mirrorPath);
  if (existing) return existing;

  const work = prepareMirror(context, options, mirrorPath).finally(() => {
    inFlight.delete(mirrorPath);
  });
  inFlight.set(mirrorPath, work);
  return work;
}

async function prepareMirror(
  context: MirrorContext,
  options: { repositoryName: string; orgUrl: string; project: string; skipFetch?: boolean },
  mirrorPath: string,
): Promise<EnsureMirrorResult> {
  const startedAt = Date.now();
  const mirrorDir = path.resolve(context.mirrorDir);
  const url = remoteUrlFor(options.orgUrl, options.project, options.repositoryName);

  const execOptions: GitExecOptions = {
    // Run from the mirror's parent. The destination is absolute, so this only
    // affects where git would resolve relative paths, and nothing here is relative.
    cwd: mirrorDir,
    pat: context.pat,
    askPassPath: context.askPassPath,
    caBundlePath: context.caBundlePath,
    // A first clone of an 822 MB repository needs generous headroom.
    timeoutMs: 20 * 60_000,
  };

  mkdirSync(mirrorDir, { recursive: true });

  const valid = await isValidMirror(context.git, mirrorPath);

  if (!valid) {
    // The mirror is a cache, so a leftover or half-cloned directory is safe to
    // discard rather than something to ask the user about.
    if (existsSync(mirrorPath)) {
      log.warn('discarding unusable mirror directory', {
        repository: options.repositoryName,
        mirrorPath,
      });
      rmSync(mirrorPath, { recursive: true, force: true, maxRetries: 3 });
    }

    log.info('cloning mirror', { repository: options.repositoryName, mirrorPath });

    // `clone --mirror` is safe; it is `push --mirror` that is destructive, and
    // the guards scope that restriction to push.
    await context.git.run(['clone', '--mirror', url, mirrorPath], execOptions);
    await disableMirrorPush(context.git, mirrorPath);

    return { mirrorPath, created: true, durationMs: Date.now() - startedAt };
  }

  // Existing mirrors cloned before this was handled still carry the flag.
  await disableMirrorPush(context.git, mirrorPath);

  if (!options.skipFetch) {
    log.debug('fetching mirror', { repository: options.repositoryName });
    // A mirror's configured refspec already covers all refs.
    await context.git.run(['fetch', '--prune', 'origin'], { ...execOptions, cwd: mirrorPath });
  }

  return { mirrorPath, created: false, durationMs: Date.now() - startedAt };
}

/** Resolves a branch to its commit sha inside the mirror. */
export async function resolveBranch(
  git: Git,
  mirrorPath: string,
  branch: string,
): Promise<string | null> {
  const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  const result = await git.tryRun(['rev-parse', '--verify', ref], {
    cwd: mirrorPath,
    timeoutMs: 30_000,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** True when the mirror already contains the commit, avoiding a needless fetch. */
export async function hasCommit(git: Git, mirrorPath: string, sha: string): Promise<boolean> {
  const result = await git.tryRun(['cat-file', '-e', `${sha}^{commit}`], {
    cwd: mirrorPath,
    timeoutMs: 30_000,
  });
  return result.exitCode === 0;
}
