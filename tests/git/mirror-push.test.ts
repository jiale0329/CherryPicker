import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Git } from '@/services/git/gitExec';
import { disableMirrorPush } from '@/services/git/mirror';
import { createWorktree } from '@/services/git/worktree';
import { COMMITTER, resolveGitExecutable, TempRepo } from '../helpers/temp-repo';

/**
 * Regression test for a bug that reached real execution.
 *
 * `git clone --mirror` sets remote.origin.mirror=true, and with that flag git
 * rejects any push naming a refspec:
 *
 *   fatal: --mirror can't be combined with refspecs
 *
 * A mirror remote means "push every ref as-is", which is exactly what this tool
 * must never do, so the flag is cleared and pushes always name an explicit
 * backport refspec. Without this, the whole push path is dead on arrival.
 *
 * Uses a local filesystem "remote", so no network and no ADO access.
 */

let origin: TempRepo;
let scratch: string;
const git = new Git(resolveGitExecutable());

beforeEach(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), 'rbm-mirror-'));

  // Stand-in for the ADO repository: a release branch with one commit.
  origin = await TempRepo.create('rbm-origin-');
  await origin.commit('initial', { 'app.txt': 'base\n' });
  await origin.branch('release/26.2.1.0');
  const fix = await origin.commit('fix on the source line', { 'app.txt': 'fixed\n' });
  // A bare source repo is required to accept pushes to a checked-out branch.
  await origin.run(['config', 'receive.denyCurrentBranch', 'ignore']);
  Object.assign(globalThis, { __fixSha: fix });
});

afterEach(() => {
  origin.cleanup();
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* windows file handles */
  }
});

describe('pushing from a worktree of a mirror clone', () => {
  it('fails while remote.origin.mirror is set', async () => {
    const mirrorPath = path.join(scratch, 'repo.git');
    await git.run(['clone', '--mirror', origin.dir, mirrorPath], {
      cwd: scratch,
      timeoutMs: 60_000,
    });

    const flag = await git.tryRun(['config', '--get', 'remote.origin.mirror'], {
      cwd: mirrorPath,
      timeoutMs: 30_000,
    });
    expect(flag.stdout.trim()).toBe('true');

    const worktree = await createWorktree({
      git,
      mirrorPath,
      worktreeDir: path.join(scratch, 'wt'),
      branch: 'backport/PR-1-26.2.1.0',
      startPoint: 'release/26.2.1.0',
      committer: COMMITTER,
      jobId: 'job-before',
    });

    const push = await worktree.exec(
      ['push', 'origin', 'HEAD:refs/heads/backport/PR-1-26.2.1.0'],
      { allowFailure: true },
    );

    expect(push.exitCode).not.toBe(0);
    expect(`${push.stderr}${push.stdout}`).toMatch(/can't be combined with refspecs/i);

    await worktree.dispose();
  });

  it('succeeds once the flag is cleared, and pushes only the backport ref', async () => {
    const mirrorPath = path.join(scratch, 'repo2.git');
    await git.run(['clone', '--mirror', origin.dir, mirrorPath], {
      cwd: scratch,
      timeoutMs: 60_000,
    });

    await disableMirrorPush(git, mirrorPath);

    // Fetch refspec must survive, so the mirror still tracks every ref.
    const fetchSpec = await git.tryRun(['config', '--get', 'remote.origin.fetch'], {
      cwd: mirrorPath,
      timeoutMs: 30_000,
    });
    expect(fetchSpec.stdout.trim()).toBe('+refs/*:refs/*');

    const worktree = await createWorktree({
      git,
      mirrorPath,
      worktreeDir: path.join(scratch, 'wt2'),
      branch: 'backport/PR-1-26.2.1.0',
      startPoint: 'release/26.2.1.0',
      committer: COMMITTER,
      jobId: 'job-after',
    });

    const fixSha = (globalThis as unknown as { __fixSha: string }).__fixSha;
    const pick = await worktree.exec(['cherry-pick', '-x', fixSha], { allowFailure: true });
    expect(pick.exitCode).toBe(0);

    const push = await worktree.exec(['push', 'origin', 'HEAD:refs/heads/backport/PR-1-26.2.1.0']);
    expect(push.exitCode).toBe(0);

    // The backport branch arrived, and nothing else was touched.
    const refs = await origin.run(['branch', '--list']);
    expect(refs.stdout).toContain('backport/PR-1-26.2.1.0');

    const releaseTip = await origin.run(['rev-parse', 'release/26.2.1.0']);
    const backportTip = await origin.run(['rev-parse', 'backport/PR-1-26.2.1.0']);
    expect(releaseTip.stdout.trim()).not.toBe(backportTip.stdout.trim());

    await worktree.dispose();
  });
});
