import { describe, expect, it } from 'vitest';

import {
  buildBackportBranchName,
  isIndividualApproval,
  parseBackportBranch,
  parseCherryPickTrailers,
  parseWorkItemKey,
  resolveCellStatus,
  slugifyTitle,
  type CellEvidenceInput,
  type TargetPullRequestEvidence,
} from './correlation';

describe('parseWorkItemKey', () => {
  // Real source branch names sampled from jblprd/jemsmm.
  it.each([
    ['hotfix/1492105-optimized-nextnumber-ef-query', '1492105'],
    ['hotfix/1507096-external-oktostart-api-issue-26.2.1.PRE', '1507096'],
    ['refs/heads/hotfix/1524226-wip-maintenance-save-error-PRE', '1524226'],
    ['feature/1521811-phantom-material', '1521811'],
    ['hotfix/1511290-fix', '1511290'],
  ])('extracts the work item id from %s', (branch, expected) => {
    expect(parseWorkItemKey(branch)).toBe(expected);
  });

  it('returns null for branches without a work item id', () => {
    expect(parseWorkItemKey('release/26.2.1.PRE')).toBeNull();
    expect(parseWorkItemKey('hotfix/no-number-here')).toBeNull();
    expect(parseWorkItemKey('develop')).toBeNull();
  });

  it('does not treat a short number as a work item id', () => {
    expect(parseWorkItemKey('hotfix/12-thing')).toBeNull();
  });
});

describe('parseBackportBranch', () => {
  it('round-trips a generated backport-prefixed name', () => {
    const name = buildBackportBranchName('backport/PR-{prId}-{targetSlug}', {
      prId: 1842,
      targetBranch: 'release/26.5.1.PRE',
    });
    expect(name).toBe('backport/PR-1842-26.5.1.PRE');

    const parsed = parseBackportBranch(name);
    expect(parsed).toEqual({ originalPrId: 1842, targetSlug: '26.5.1.PRE' });
  });

  it('ignores unrelated branches', () => {
    expect(parseBackportBranch('hotfix/1492105-thing')).toBeNull();
  });
});

describe('slugifyTitle', () => {
  it('drops the leading repo and release tag', () => {
    expect(slugifyTitle('Cherry-Pick | packout | 26.2.1.PRE | Fix phantom parent resolution')).toBe(
      'fix-phantom-parent-resolution',
    );
  });

  it('collapses punctuation into single dashes', () => {
    expect(slugifyTitle('HU ASN top-level serial number is  not correct!')).toBe(
      'hu-asn-top-level-serial-number-is-not-correct',
    );
  });

  it('caps the length on a word boundary', () => {
    const slug = slugifyTitle(
      'a very long description that keeps going well past any sensible branch name limit',
      40,
    );
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back rather than producing an empty slug', () => {
    expect(slugifyTitle('!!!')).toBe('fix');
  });
});

describe('buildBackportBranchName', () => {
  const values = {
    prId: 369343,
    targetBranch: 'release/26.2.1.0',
    workItemId: '1444759',
    title: 'Cherry-Pick | packout | 26.2.1.PRE | Fix phantom parent resolution',
  };

  it('builds the team convention', () => {
    expect(
      buildBackportBranchName('hotfix/{workItemId}-{slug}-on-release-{targetSlug}', values),
    ).toBe('hotfix/1444759-fix-phantom-parent-resolution-on-release-26.2.1.0');
  });

  it('gives each target release a distinct branch, so none overwrites another', () => {
    const template = 'hotfix/{workItemId}-{slug}-on-release-{targetSlug}';
    const names = ['release/26.2.1.0', 'release/26.5.1.PRE', 'release/26.8.1.0'].map((target) =>
      buildBackportBranchName(template, { ...values, targetBranch: target }),
    );
    expect(new Set(names).size).toBe(3);
  });

  it('never reproduces the original fix branch name', () => {
    // The original was hotfix/1444759-wrong-top-level-serial-number-cp; the
    // -on-release- suffix is what keeps the backport from colliding with it.
    const name = buildBackportBranchName('hotfix/{workItemId}-{slug}-on-release-{targetSlug}', {
      ...values,
      title: 'wrong top level serial number cp',
    });
    expect(name).not.toBe('hotfix/1444759-wrong-top-level-serial-number-cp');
    expect(name).toContain('-on-release-26.2.1.0');
  });

  it('falls back to the PR id when no work item is known', () => {
    expect(
      buildBackportBranchName('hotfix/{workItemId}-{slug}-on-release-{targetSlug}', {
        ...values,
        workItemId: null,
      }),
    ).toContain('hotfix/PR-369343-');
  });

  it('keeps dots so release identifiers stay readable', () => {
    expect(
      buildBackportBranchName('backport/PR-{prId}-{targetSlug}', {
        prId: 7,
        targetBranch: 'release/26.8.1.0',
      }),
    ).toBe('backport/PR-7-26.8.1.0');
  });

  it('replaces characters git would reject', () => {
    expect(
      buildBackportBranchName('backport/PR-{prId}-{targetSlug}', {
        prId: 7,
        targetBranch: 'release/26.8 beta~1',
      }),
    ).toBe('backport/PR-7-26.8-beta-1');
  });
});

describe('parseCherryPickTrailers', () => {
  it('reads the sha written by cherry-pick -x', () => {
    const message = [
      'core-application | 26.5.1.PRE | optimized ef query',
      '',
      '(cherry picked from commit 8275237d75aa0d3f1c2b4e5a6f7890abcdef1234)',
    ].join('\n');
    expect(parseCherryPickTrailers(message)).toEqual([
      '8275237d75aa0d3f1c2b4e5a6f7890abcdef1234',
    ]);
  });

  it('returns an empty list when absent', () => {
    expect(parseCherryPickTrailers('a plain commit message')).toEqual([]);
  });
});

describe('isIndividualApproval', () => {
  it('counts an individual approving vote', () => {
    expect(isIndividualApproval({ vote: 10, isContainer: false })).toBe(true);
    expect(isIndividualApproval({ vote: 5, isContainer: false })).toBe(true);
  });

  it('excludes group votes, because the policy needs a non-creator individual', () => {
    expect(isIndividualApproval({ vote: 10, isContainer: true })).toBe(false);
  });

  it('excludes rejection and waiting votes', () => {
    expect(isIndividualApproval({ vote: 0, isContainer: false })).toBe(false);
    expect(isIndividualApproval({ vote: -5, isContainer: false })).toBe(false);
    expect(isIndividualApproval({ vote: -10, isContainer: false })).toBe(false);
  });
});

const base: CellEvidenceInput = { branchExists: true };

const pr = (over: Partial<TargetPullRequestEvidence>): TargetPullRequestEvidence => ({
  pullRequestId: 999,
  state: 'active',
  approvedByIndividual: false,
  source: 'backport-branch-name',
  confidence: 'strong',
  ...over,
});

describe('resolveCellStatus', () => {
  it('marks a missing branch UNAVAILABLE so it is never counted as work', () => {
    const result = resolveCellStatus({ ...base, branchExists: false });
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.likelyAlreadyPresent).toBe(false);
  });

  it('reports MERGED for a completed target PR', () => {
    const result = resolveCellStatus({
      ...base,
      targetPullRequests: [pr({ state: 'completed', pullRequestId: 4242 })],
    });
    expect(result.status).toBe('MERGED');
    expect(result.targetPrId).toBe(4242);
  });

  it('reports MERGED when the original sha is an ancestor', () => {
    const result = resolveCellStatus({ ...base, shaIsAncestor: true });
    expect(result.status).toBe('MERGED');
    expect(result.confidence).toBe('definitive');
  });

  it('does not call a successful cherry-pick complete', () => {
    const result = resolveCellStatus({ ...base, job: { status: 'CHERRY_PICKED' } });
    expect(result.status).toBe('CHERRY_PICKED');
    expect(result.status).not.toBe('MERGED');
  });

  it('distinguishes an approved open PR from a merged one', () => {
    const approved = resolveCellStatus({
      ...base,
      targetPullRequests: [pr({ state: 'active', approvedByIndividual: true })],
    });
    expect(approved.status).toBe('PR_APPROVED');

    const awaiting = resolveCellStatus({
      ...base,
      targetPullRequests: [pr({ state: 'active', approvedByIndividual: false })],
    });
    expect(awaiting.status).toBe('PR_CREATED');
  });

  it('lets a running job win over stale PR data', () => {
    const result = resolveCellStatus({
      ...base,
      job: { status: 'PROCESSING' },
      targetPullRequests: [pr({ state: 'active' })],
    });
    expect(result.status).toBe('PROCESSING');
  });

  it('prefers a completed PR over a stale FAILED record', () => {
    // A developer may have finished the backport by hand after a failed run.
    const result = resolveCellStatus({
      ...base,
      job: { status: 'FAILED' },
      targetPullRequests: [pr({ state: 'completed', pullRequestId: 5150 })],
    });
    expect(result.status).toBe('MERGED');
    expect(result.targetPrId).toBe(5150);
  });

  it('surfaces a conflict so it can be retried', () => {
    const result = resolveCellStatus({ ...base, job: { status: 'CONFLICT' } });
    expect(result.status).toBe('CONFLICT');
  });

  it('reopens the cell when the backport PR was abandoned', () => {
    const result = resolveCellStatus({
      ...base,
      job: { status: 'PR_CREATED', targetPrId: 77 },
      targetPullRequests: [pr({ state: 'abandoned', pullRequestId: 77 })],
    });
    expect(result.status).toBe('NOT_STARTED');
  });

  it('never marks a cell done on patch-id evidence alone', () => {
    const result = resolveCellStatus({
      ...base,
      patchMatch: { present: true, detail: 'equivalent patch 3 commits back' },
    });

    expect(result.status).toBe('NOT_STARTED');
    expect(result.status).not.toBe('MERGED');
    expect(result.status).not.toBe('SKIPPED');
    expect(result.likelyAlreadyPresent).toBe(true);
    expect(result.confidence).toBe('weak');
    expect(result.evidence[0].detail).toMatch(/equivalent patch/);
  });

  it('reports NOT_STARTED with no evidence at all', () => {
    const result = resolveCellStatus(base);
    expect(result.status).toBe('NOT_STARTED');
    expect(result.likelyAlreadyPresent).toBe(false);
  });
});
