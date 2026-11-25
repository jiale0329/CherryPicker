import { describe, expect, it } from 'vitest';

import { summarise, type MatrixBugRow, type MatrixCell, type MatrixFix } from './matrix';
import { describeStatus, type MatrixCellStatus } from '@/types/backport/status';

/**
 * Covers summary arithmetic for the bug-level, multi-repository model.
 *
 * A bug may be fixed in several repositories and each is backported separately,
 * so a bug counts as fully backported only when every expected target in every
 * repository is merged. Cells that are not expected - an absent branch, or a
 * release preceding the fix's origin - must neither count as work nor satisfy
 * completeness.
 */

type CellSpec = {
  branch: string;
  status: MatrixCellStatus;
  expected?: boolean;
  isOrigin?: boolean;
};

function cell(spec: CellSpec): MatrixCell {
  const descriptor = describeStatus(spec.status);
  return {
    branchName: spec.branch,
    status: spec.status,
    label: descriptor.label,
    colorVar: descriptor.colorVar,
    confidence: 'strong',
    likelyAlreadyPresent: false,
    evidence: [],
    actionable: false,
    isOrigin: spec.isOrigin ?? false,
    expected: spec.expected ?? true,
  };
}

function fix(repositoryName: string, specs: CellSpec[]): MatrixFix {
  const cells = specs.map(cell);
  return {
    key: `${repositoryName}::wi:1234567`,
    repositoryName,
    adoRepositoryId: `${repositoryName}-id`,
    title: 'fix something',
    author: 'Someone',
    authorId: 'someone-id',
    originBranch: specs.find((spec) => spec.isOrigin)?.branch ?? specs[0].branch,
    originPullRequestId: 1842,
    originClosedAt: '2026-01-01T00:00:00.000Z',
    sourceBranch: 'hotfix/1234567-fix',
    mergeStrategy: 'squash',
    lastMergeCommitSha: 'abc1234567',
    missingCount: cells.filter(
      (item) => item.expected && !item.isOrigin && !describeStatus(item.status).isComplete,
    ).length,
    cells,
  };
}

function bug(fixes: MatrixFix[]): MatrixBugRow {
  return {
    key: 'wi:1234567',
    workItemId: 1234567,
    workItemState: 'Done',
    workItemType: 'Bug',
    assignedTo: null,
    title: 'a bug',
    authoredByMe: false,
    assignedToMe: false,
    isMine: false,
    isWorkItemOpen: false,
    category: 'OTHERS_CLOSED',
    isWatched: false,
    repositories: fixes.map((item) => item.repositoryName),
    missingCount: fixes.reduce((total, item) => total + item.missingCount, 0),
    latestClosedAt: '2026-01-01T00:00:00.000Z',
    fixes,
    cells: [],
  };
}

const ORIGIN = { branch: 'release/26.2.1.PRE', status: 'MERGED' as const, isOrigin: true };

describe('summarise', () => {
  it('counts a bug complete only when every expected target is merged', () => {
    const summary = summarise([
      bug([
        fix('core-application', [
          ORIGIN,
          { branch: 'release/26.5.1.PRE', status: 'MERGED' },
          { branch: 'release/26.8.1.PRE', status: 'MERGED' },
        ]),
      ]),
    ]);
    expect(summary.fullyBackported).toBe(1);
    expect(summary.outstanding).toBe(0);
  });

  it('requires every repository, not just one, before a bug is complete', () => {
    const summary = summarise([
      bug([
        fix('core-application', [ORIGIN, { branch: 'release/26.5.1.PRE', status: 'MERGED' }]),
        fix('core-sqldatabase', [ORIGIN, { branch: 'release/26.5.1.PRE', status: 'NOT_STARTED' }]),
      ]),
    ]);
    expect(summary.fullyBackported).toBe(0);
    expect(summary.outstanding).toBe(1);
  });

  it('sums missing backports across repositories', () => {
    const subject = bug([
      fix('core-application', [
        ORIGIN,
        { branch: 'release/26.5.1.PRE', status: 'NOT_STARTED' },
        { branch: 'release/26.8.1.PRE', status: 'NOT_STARTED' },
      ]),
      fix('packout', [ORIGIN, { branch: 'release/26.5.1.PRE', status: 'NOT_STARTED' }]),
    ]);
    expect(subject.missingCount).toBe(3);
  });

  it('does not treat a cherry-pick as a completed backport', () => {
    const summary = summarise([
      bug([fix('core-application', [ORIGIN, { branch: 'release/26.5.1.PRE', status: 'CHERRY_PICKED' }])]),
    ]);
    expect(summary.fullyBackported).toBe(0);
    expect(summary.outstanding).toBe(1);
  });

  it('treats an open PR as awaiting approval, not complete', () => {
    const summary = summarise([
      bug([fix('core-application', [ORIGIN, { branch: 'release/26.5.1.PRE', status: 'PR_CREATED' }])]),
    ]);
    expect(summary.fullyBackported).toBe(0);
    expect(summary.awaitingPrApproval).toBe(1);
  });

  it('counts a conflict in any repository', () => {
    const summary = summarise([
      bug([
        fix('core-application', [ORIGIN, { branch: 'release/26.5.1.PRE', status: 'MERGED' }]),
        fix('packout', [ORIGIN, { branch: 'release/26.5.1.PRE', status: 'CONFLICT' }]),
      ]),
    ]);
    expect(summary.failedOrConflicted).toBe(1);
    expect(summary.outstanding).toBe(1);
  });

  it('excludes the origin cell from completeness', () => {
    const summary = summarise([
      bug([fix('core-application', [ORIGIN, { branch: 'release/26.5.1.PRE', status: 'NOT_STARTED' }])]),
    ]);
    expect(summary.fullyBackported).toBe(0);
    expect(summary.outstanding).toBe(1);
  });

  it('ignores branches absent from a repository', () => {
    const summary = summarise([
      bug([
        fix('core-sqldatabase', [
          ORIGIN,
          { branch: 'release/26.5.1.PRE', status: 'MERGED' },
          { branch: 'release/26.8.1.PRE', status: 'UNAVAILABLE', expected: false },
        ]),
      ]),
    ]);
    expect(summary.fullyBackported).toBe(1);
    expect(summary.outstanding).toBe(0);
  });

  it('ignores releases preceding the origin', () => {
    // A fix born on 26.8 is not missing from 26.2 or 26.5.
    const summary = summarise([
      bug([
        fix('core-application', [
          { branch: 'release/26.2.1.PRE', status: 'UNAVAILABLE', expected: false },
          { branch: 'release/26.5.1.PRE', status: 'UNAVAILABLE', expected: false },
          { branch: 'release/26.8.1.PRE', status: 'MERGED', isOrigin: true },
          { branch: 'release/26.8.1.0', status: 'MERGED' },
        ]),
      ]),
    ]);
    expect(summary.fullyBackported).toBe(1);
    expect(summary.outstanding).toBe(0);
  });

  it('does not count a bug whose origin is its only expected branch', () => {
    const summary = summarise([
      bug([
        fix('core-application', [
          { branch: 'release/26.8.1.0', status: 'MERGED', isOrigin: true },
          { branch: 'release/26.2.1.PRE', status: 'UNAVAILABLE', expected: false },
        ]),
      ]),
    ]);
    expect(summary.totalFixes).toBe(1);
    expect(summary.fullyBackported).toBe(0);
    expect(summary.outstanding).toBe(0);
  });

  it('treats an already-present fix as not outstanding', () => {
    const summary = summarise([
      bug([fix('core-application', [ORIGIN, { branch: 'release/26.5.1.PRE', status: 'SKIPPED' }])]),
    ]);
    expect(summary.outstanding).toBe(0);
    expect(summary.fullyBackported).toBe(0);
  });
});
