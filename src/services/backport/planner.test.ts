import { describe, expect, it } from 'vitest';

import {
  cherryPickArgs,
  normaliseStrategy,
  planCherryPick,
  type MergedPullRequestInput,
} from './planner';

/**
 * Fixtures mirror real PRs observed in jblprd/jemsmm during the Phase 0 probe,
 * so the tests fail if the planner stops handling the shapes that actually
 * occur in this project.
 */
const squashPr: MergedPullRequestInput = {
  // core-application PR 384144, squash into release/26.2.1.PRE
  pullRequestId: 384144,
  sourceRefName: 'refs/heads/hotfix/1492105-optimized-nextnumber-ef-query',
  targetRefName: 'refs/heads/release/26.2.1.PRE',
  squashMerge: true,
  mergeStrategy: 'squash',
  lastMergeCommitSha: '8275237d75aa0d3f1c2b4e5a6f7890abcdef1234',
  lastMergeParentCount: 1,
  sourceCommitShas: ['aaa1111111111111111111111111111111111111'],
};

const mergeCommitPr: MergedPullRequestInput = {
  // core-application PR 341609, noFastForward into release/26.2.1.0
  pullRequestId: 341609,
  sourceRefName: 'refs/heads/hotfix/1400000-then-by-clause',
  targetRefName: 'refs/heads/release/26.2.1.0',
  squashMerge: null,
  mergeStrategy: 'noFastForward',
  lastMergeCommitSha: 'c3d77e9ac1bb0d3f1c2b4e5a6f7890abcdef5678',
  lastMergeParentCount: 2,
};

describe('normaliseStrategy', () => {
  it('treats the squashMerge flag as authoritative', () => {
    expect(normaliseStrategy({ ...squashPr, mergeStrategy: null })).toBe('squash');
  });

  it('reads the mergeStrategy field case-insensitively', () => {
    expect(normaliseStrategy({ ...mergeCommitPr, mergeStrategy: 'noFastForward' })).toBe(
      'noFastForward',
    );
    expect(normaliseStrategy({ ...mergeCommitPr, mergeStrategy: 'NOFASTFORWARD' })).toBe(
      'noFastForward',
    );
  });

  it('reports unknown when completionOptions is absent', () => {
    expect(normaliseStrategy({ ...mergeCommitPr, squashMerge: null, mergeStrategy: null })).toBe(
      'unknown',
    );
  });
});

describe('planCherryPick', () => {
  it('picks the squashed commit, not the source-branch commits', () => {
    const result = planCherryPick(squashPr);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The source branch commit must never appear in the plan.
    expect(result.plan.commitShas).toEqual([squashPr.lastMergeCommitSha]);
    expect(result.plan.commitShas).not.toContain(squashPr.sourceCommitShas?.[0]);
    expect(result.plan.mode).toBe('single');
  });

  it('uses -m 1 for a two-parent merge commit', () => {
    const result = planCherryPick(mergeCommitPr);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.mode).toBe('mainline');
    expect(cherryPickArgs(result.plan)).toEqual([
      'cherry-pick',
      '-x',
      '-m',
      '1',
      mergeCommitPr.lastMergeCommitSha,
    ]);
  });

  it('records -x so the origin sha is written into the message', () => {
    const result = planCherryPick(squashPr);
    if (!result.ok) throw new Error('expected a plan');
    expect(cherryPickArgs(result.plan)).toContain('-x');
  });

  it('strips refs/heads/ from branch names', () => {
    const result = planCherryPick(squashPr);
    if (!result.ok) throw new Error('expected a plan');
    expect(result.plan.targetBranch).toBe('release/26.2.1.PRE');
    expect(result.plan.sourceBranch).toBe('hotfix/1492105-optimized-nextnumber-ef-query');
  });

  it('refuses when lastMergeCommit is missing rather than guessing', () => {
    const result = planCherryPick({ ...squashPr, lastMergeCommitSha: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('NO_MERGE_COMMIT');
    expect(result.refusal.remedy).not.toHaveLength(0);
  });

  it('refuses when the parent count is unknown', () => {
    const result = planCherryPick({ ...squashPr, lastMergeParentCount: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('UNKNOWN_PARENT_COUNT');
  });

  it('refuses an octopus merge', () => {
    const result = planCherryPick({ ...mergeCommitPr, lastMergeParentCount: 3 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('OCTOPUS_MERGE');
  });

  it('trusts the commit shape over a contradictory strategy label', () => {
    // Marked squash, but the commit really has two parents.
    const result = planCherryPick({ ...squashPr, lastMergeParentCount: 2 });
    if (!result.ok) throw new Error('expected a plan');
    expect(result.plan.mode).toBe('mainline');
    expect(result.plan.warnings.join(' ')).toMatch(/two parents/i);
  });

  it('infers from parent count when completionOptions is absent', () => {
    const result = planCherryPick({
      ...squashPr,
      squashMerge: null,
      mergeStrategy: null,
      lastMergeParentCount: 1,
    });
    if (!result.ok) throw new Error('expected a plan');
    expect(result.plan.mode).toBe('single');
    expect(result.plan.warnings.join(' ')).toMatch(/no completionOptions/i);
  });

  it('refuses a multi-commit rebase instead of silently dropping commits', () => {
    const result = planCherryPick({
      ...squashPr,
      squashMerge: null,
      mergeStrategy: 'rebase',
      sourceCommitShas: ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('AMBIGUOUS_RANGE');
    expect(result.refusal.message).toMatch(/3 commits/);
  });

  it('allows a single-commit rebase with a warning', () => {
    const result = planCherryPick({
      ...squashPr,
      squashMerge: null,
      mergeStrategy: 'rebase',
      sourceCommitShas: ['a'.repeat(40)],
    });
    if (!result.ok) throw new Error('expected a plan');
    expect(result.plan.mode).toBe('single');
    expect(result.plan.warnings).toHaveLength(1);
  });

  it('never produces shell-quoted arguments', () => {
    const result = planCherryPick(squashPr);
    if (!result.ok) throw new Error('expected a plan');
    for (const arg of cherryPickArgs(result.plan)) {
      expect(arg).not.toMatch(/[;&|`$]/);
    }
  });
});
