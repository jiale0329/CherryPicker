import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cherryPickArgs, planCherryPick } from '@/services/backport/planner';
import { checkForDuplicate } from '@/services/git/duplicate';
import { GitCommandError } from '@/services/git/gitExec';
import { COMMITTER, TempRepo } from '../helpers/temp-repo';

/**
 * Integration tests against real git in temporary repositories.
 *
 * These cover the behaviour unit tests cannot: that the planner's arguments
 * actually apply the intended change, that a squash-merged pull request
 * backports correctly, that conflicts are detected and recoverable, and that
 * duplicate detection survives the hash change a cherry-pick causes.
 */

let repo: TempRepo;

const exec = (args: readonly string[]) =>
  repo.git.run(args, { cwd: repo.dir, committer: COMMITTER, timeoutMs: 30_000 });
const tryExec = (args: readonly string[]) =>
  repo.git.run(args, { cwd: repo.dir, committer: COMMITTER, timeoutMs: 30_000, allowFailure: true });

beforeEach(async () => {
  repo = await TempRepo.create();
});

afterEach(() => {
  repo.cleanup();
});

describe('cherry-picking a squash-merged fix', () => {
  it('applies the squashed commit, not the source branch commits', async () => {
    // release/old is the source line; the fix is squashed onto it.
    await repo.commit('initial', { 'app.txt': 'line1\nline2\nline3\n' });
    await repo.branch('release/old');
    await repo.branch('release/new');

    await repo.checkout('release/old');
    // A squash merge leaves exactly one single-parent commit.
    const squashed = await repo.commit('app | old | fix the thing', {
      'app.txt': 'line1\nFIXED\nline3\n',
    });

    const parents = await exec(['rev-list', '--parents', '-n', '1', squashed]);
    expect(parents.stdout.trim().split(' ')).toHaveLength(2); // commit + 1 parent

    const plan = planCherryPick({
      pullRequestId: 1842,
      sourceRefName: 'refs/heads/hotfix/1234567-fix',
      targetRefName: 'refs/heads/release/new',
      squashMerge: true,
      mergeStrategy: 'squash',
      lastMergeCommitSha: squashed,
      lastMergeParentCount: 1,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    await repo.checkout('release/new');
    await exec(cherryPickArgs(plan.plan));

    expect(repo.fileContents('app.txt')).toBe('line1\nFIXED\nline3\n');

    // -x records the origin, which duplicate detection later relies on.
    const message = await exec(['log', '-1', '--format=%B']);
    expect(message.stdout).toContain(`cherry picked from commit ${squashed}`);
  });

  it('produces a different sha, which is why hash comparison cannot work', async () => {
    await repo.commit('initial', { 'a.txt': 'x\n' });
    await repo.branch('release/new');
    const original = await repo.commit('fix', { 'a.txt': 'y\n' });

    await repo.checkout('release/new');
    await exec(['cherry-pick', '-x', original]);
    const backported = await repo.head();

    expect(backported).not.toBe(original);
  });
});

describe('cherry-picking a merge commit', () => {
  it('needs -m 1 and applies only the change the PR introduced', async () => {
    await repo.commit('initial', { 'app.txt': 'base\n' });
    await repo.branch('release/new');

    // Feature branch with the fix.
    await repo.run(['checkout', '-b', 'hotfix/1234567-fix']);
    await repo.commit('work in progress', { 'feature.txt': 'wip\n' });
    await repo.commit('the actual fix', { 'feature.txt': 'done\n' });

    // Merge it with a true merge commit, as a noFastForward completion does.
    await repo.checkout('main');
    await exec(['merge', '--no-ff', '-m', 'Merged PR 1842: fix', 'hotfix/1234567-fix']);
    const mergeSha = await repo.head();

    const parents = await exec(['rev-list', '--parents', '-n', '1', mergeSha]);
    expect(parents.stdout.trim().split(' ')).toHaveLength(3); // commit + 2 parents

    const plan = planCherryPick({
      pullRequestId: 1842,
      sourceRefName: 'refs/heads/hotfix/1234567-fix',
      targetRefName: 'refs/heads/release/new',
      mergeStrategy: 'noFastForward',
      lastMergeCommitSha: mergeSha,
      lastMergeParentCount: 2,
    });
    if (!plan.ok) throw new Error('expected a plan');
    expect(plan.plan.mode).toBe('mainline');
    expect(cherryPickArgs(plan.plan)).toContain('-m');

    await repo.checkout('release/new');
    await exec(cherryPickArgs(plan.plan));

    // Both commits from the merged branch arrive as one squashed change.
    expect(repo.fileContents('feature.txt')).toBe('done\n');
  });

  it('fails without -m 1, which is what the planner prevents', async () => {
    await repo.commit('initial', { 'app.txt': 'base\n' });
    await repo.branch('release/new');
    await repo.run(['checkout', '-b', 'feature']);
    await repo.commit('fix', { 'feature.txt': 'done\n' });
    await repo.checkout('main');
    await exec(['merge', '--no-ff', '-m', 'merge', 'feature']);
    const mergeSha = await repo.head();

    await repo.checkout('release/new');
    const result = await tryExec(['cherry-pick', '-x', mergeSha]);

    expect(result.exitCode).not.toBe(0);
    // git 2.48 wording: "is a merge but no -m option was given".
    expect(`${result.stderr}${result.stdout}`).toMatch(/no -m option was given/i);
  });
});

describe('conflict handling', () => {
  it('reports the conflicted files and leaves the pick recoverable', async () => {
    await repo.commit('initial', { 'app.txt': 'original\n' });
    await repo.branch('release/new');

    const fix = await repo.commit('fix on source', { 'app.txt': 'source change\n' });

    // The target branch changed the same line, so the pick must conflict.
    await repo.checkout('release/new');
    await repo.commit('divergent change', { 'app.txt': 'target change\n' });

    const result = await tryExec(['cherry-pick', '-x', fix]);
    expect(result.exitCode).not.toBe(0);

    const conflicted = await exec(['diff', '--name-only', '--diff-filter=U']);
    expect(conflicted.stdout.trim().split('\n')).toContain('app.txt');

    // Aborting restores the branch exactly, leaving nothing half-applied.
    await exec(['cherry-pick', '--abort']);

    const status = await exec(['status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');
    expect(repo.fileContents('app.txt')).toBe('target change\n');
  });

  it('a retry after the conflict is resolved succeeds', async () => {
    await repo.commit('initial', { 'app.txt': 'a\nb\nc\n' });
    await repo.branch('release/new');
    const fix = await repo.commit('fix', { 'app.txt': 'a\nFIXED\nc\n' });

    await repo.checkout('release/new');
    await repo.commit('other', { 'app.txt': 'a\nOTHER\nc\n' });

    expect((await tryExec(['cherry-pick', '-x', fix])).exitCode).not.toBe(0);

    // Resolve by hand, as the detail panel will instruct.
    repo.write('app.txt', 'a\nFIXED\nc\n');
    await exec(['add', 'app.txt']);
    const continued = await tryExec(['-c', 'core.editor=true', 'cherry-pick', '--continue']);

    expect(continued.exitCode).toBe(0);
    expect(repo.fileContents('app.txt')).toBe('a\nFIXED\nc\n');
  });
});

describe('duplicate detection', () => {
  const options = () => ({ cwd: repo.dir, committer: COMMITTER, timeoutMs: 30_000 });

  it('detects the exact commit by ancestry', async () => {
    const base = await repo.commit('initial', { 'a.txt': 'x\n' });
    await repo.branch('release/new');

    const check = await checkForDuplicate({
      git: repo.git,
      options: options(),
      commitSha: base,
      targetRef: 'release/new',
    });

    expect(check.alreadyPresent).toBe(true);
    expect(check.evidence[0].source).toBe('ancestry');
    expect(check.evidence[0].confidence).toBe('definitive');
  });

  it('detects a previous cherry-pick by its recorded trailer', async () => {
    await repo.commit('initial', { 'a.txt': 'x\n' });
    await repo.branch('release/new');
    const original = await repo.commit('fix', { 'a.txt': 'y\n' });

    await repo.checkout('release/new');
    await exec(['cherry-pick', '-x', original]);

    const check = await checkForDuplicate({
      git: repo.git,
      options: options(),
      commitSha: original,
      targetRef: 'release/new',
    });

    expect(check.alreadyPresent).toBe(true);
    expect(check.evidence[0].source).toBe('commit-trailer');
    expect(check.candidates).toHaveLength(1);
  });

  it('flags an equivalent patch as likely, never as definitely present', async () => {
    await repo.commit('initial', { 'a.txt': 'x\n' });
    await repo.branch('release/new');
    const original = await repo.commit('fix', { 'a.txt': 'y\n' });

    // Same change applied by hand, so no trailer records the origin.
    await repo.checkout('release/new');
    await repo.commit('same change, applied manually', { 'a.txt': 'y\n' });

    const check = await checkForDuplicate({
      git: repo.git,
      options: options(),
      commitSha: original,
      targetRef: 'release/new',
    });

    // The brief is explicit: a patch match must not be reported as merged.
    expect(check.alreadyPresent).toBe(false);
    expect(check.likelyPresent).toBe(true);
    expect(check.evidence[0].confidence).toBe('weak');
    expect(check.evidence[0].detail).toMatch(/review before skipping/i);
  });

  it('reports nothing found when the fix is genuinely absent', async () => {
    await repo.commit('initial', { 'a.txt': 'x\n' });
    await repo.branch('release/new');
    const original = await repo.commit('fix', { 'a.txt': 'y\n' });

    await repo.checkout('release/new');
    await repo.commit('unrelated', { 'b.txt': 'other\n' });

    const check = await checkForDuplicate({
      git: repo.git,
      options: options(),
      commitSha: original,
      targetRef: 'release/new',
    });

    expect(check.alreadyPresent).toBe(false);
    expect(check.likelyPresent).toBe(false);
  });
});

describe('safety', () => {
  it('refuses a force push before spawning git', async () => {
    await repo.commit('initial', { 'a.txt': 'x\n' });

    await expect(
      repo.git.run(['push', '--force', 'origin', 'backport/PR-1-26.5'], {
        cwd: repo.dir,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/never force-updates/i);
  });

  it('refuses a push to a release branch', async () => {
    await repo.commit('initial', { 'a.txt': 'x\n' });

    await expect(
      repo.git.run(['push', 'origin', 'HEAD:refs/heads/release/26.5.1.0'], {
        cwd: repo.dir,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/never written by this tool/i);
  });

  it('surfaces a real git failure as GitCommandError with output captured', async () => {
    await expect(
      repo.git.run(['rev-parse', 'does-not-exist'], { cwd: repo.dir, timeoutMs: 10_000 }),
    ).rejects.toThrow(GitCommandError);
  });
});
