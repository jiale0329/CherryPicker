import { describe, expect, it } from 'vitest';

import { applySelection, groupJobsByBranch, jobKey, planJobs } from './jobSelection';
import type { MatrixBugRow, MatrixCell, MatrixFix, MatrixResult } from '@/services/backport/matrix';
import { describeStatus, type MatrixCellStatus } from '@/types/backport/status';

/**
 * planJobs decides what the Create Backport PRs button will actually create,
 * so it is the last gate before a write. It must only ever produce jobs for
 * releases that are expected, missing and actionable - never the origin, never
 * an absent branch, never one that already has an open pull request.
 */

type CellSpec = {
  branch: string;
  status: MatrixCellStatus;
  expected?: boolean;
  isOrigin?: boolean;
  actionable?: boolean;
};

function cell(spec: CellSpec): MatrixCell {
  const descriptor = describeStatus(spec.status);
  const expected = spec.expected ?? true;
  const isOrigin = spec.isOrigin ?? false;
  return {
    branchName: spec.branch,
    status: spec.status,
    label: descriptor.label,
    colorVar: descriptor.colorVar,
    confidence: 'strong',
    likelyAlreadyPresent: false,
    evidence: [],
    isOrigin,
    expected,
    actionable:
      spec.actionable ??
      (expected &&
        !isOrigin &&
        (spec.status === 'NOT_STARTED' || spec.status === 'CONFLICT' || spec.status === 'FAILED')),
  };
}

function fix(repositoryName: string, prId: number, specs: CellSpec[]): MatrixFix {
  return {
    key: `${repositoryName}::wi:1444759`,
    repositoryName,
    adoRepositoryId: `${repositoryName}-id`,
    title: 'a fix',
    author: 'Someone',
    authorId: 'someone-id',
    originBranch: specs.find((s) => s.isOrigin)?.branch ?? specs[0].branch,
    originPullRequestId: prId,
    originClosedAt: null,
    sourceBranch: 'hotfix/1444759-thing',
    mergeStrategy: 'squash',
    lastMergeCommitSha: 'abc',
    missingCount: 0,
    cells: specs.map(cell),
  };
}

function bug(key: string, fixes: MatrixFix[]): MatrixBugRow {
  return {
    key,
    workItemId: 1444759,
    workItemState: 'Done',
    workItemType: 'Bug',
    assignedTo: null,
    title: 'HU ASN top level serial number is not correct',
    authoredByMe: false,
    assignedToMe: false,
    isMine: false,
    isWorkItemOpen: false,
    category: 'OTHERS_CLOSED',
    isWatched: false,
    repositories: fixes.map((f) => f.repositoryName),
    missingCount: 0,
    latestClosedAt: null,
    fixes,
    cells: [],
  };
}

function matrixOf(rows: MatrixBugRow[]): MatrixResult {
  return {
    columns: [],
    rows,
    summary: {
      totalFixes: rows.length,
      fullyBackported: 0,
      outstanding: 0,
      awaitingPrApproval: 0,
      failedOrConflicted: 0,
    },
    lastSyncedAt: null,
    totalRows: rows.length,
    repositories: [],
    filtered: { totalBeforeFilters: rows.length, hiddenRows: 0, hiddenMissingBackports: 0 },
    availableWorkItemStates: [],
    scope: { watchedRows: 0, allRows: rows.length, watchedMissingBackports: 0, allMissingBackports: 0 },
    categories: [],
  };
}

const ORIGIN = { branch: 'release/26.2.1.PRE', status: 'MERGED' as const, isOrigin: true };

describe('planJobs', () => {
  it('creates one job per missing release', () => {
    const matrix = matrixOf([
      bug('wi:1', [
        fix('packout', 369343, [
          ORIGIN,
          { branch: 'release/26.2.1.0', status: 'NOT_STARTED' },
          { branch: 'release/26.5.1.PRE', status: 'NOT_STARTED' },
        ]),
      ]),
    ]);

    const jobs = planJobs(matrix, new Set(['wi:1']));
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.targetBranch)).toEqual([
      'release/26.2.1.0',
      'release/26.5.1.PRE',
    ]);
    expect(jobs.every((job) => job.pullRequestId === 369343)).toBe(true);
  });

  it('spans repositories for a bug fixed in more than one', () => {
    const matrix = matrixOf([
      bug('wi:1', [
        fix('core-sqldatabase', 369344, [ORIGIN, { branch: 'release/26.2.1.0', status: 'NOT_STARTED' }]),
        fix('packout', 369343, [ORIGIN, { branch: 'release/26.2.1.0', status: 'NOT_STARTED' }]),
      ]),
    ]);

    const jobs = planJobs(matrix, new Set(['wi:1']));
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.repository).sort()).toEqual(['core-sqldatabase', 'packout']);
  });

  it('never targets the origin release', () => {
    const matrix = matrixOf([bug('wi:1', [fix('packout', 1, [ORIGIN])])]);
    expect(planJobs(matrix, new Set(['wi:1']))).toHaveLength(0);
  });

  it('skips releases already merged', () => {
    const matrix = matrixOf([
      bug('wi:1', [fix('packout', 1, [ORIGIN, { branch: 'release/26.5.1.0', status: 'MERGED' }])]),
    ]);
    expect(planJobs(matrix, new Set(['wi:1']))).toHaveLength(0);
  });

  it('skips releases that already have an open pull request', () => {
    const matrix = matrixOf([
      bug('wi:1', [
        fix('packout', 1, [ORIGIN, { branch: 'release/26.5.1.0', status: 'PR_CREATED' }]),
      ]),
    ]);
    expect(planJobs(matrix, new Set(['wi:1']))).toHaveLength(0);
  });

  it('skips branches that do not exist in the repository', () => {
    const matrix = matrixOf([
      bug('wi:1', [
        fix('core-sqldatabase', 1, [
          ORIGIN,
          { branch: 'release/26.8.1.0', status: 'UNAVAILABLE', expected: false },
        ]),
      ]),
    ]);
    expect(planJobs(matrix, new Set(['wi:1']))).toHaveLength(0);
  });

  it('includes a conflicted release so it can be retried', () => {
    const matrix = matrixOf([
      bug('wi:1', [fix('packout', 1, [ORIGIN, { branch: 'release/26.5.1.0', status: 'CONFLICT' }])]),
    ]);
    expect(planJobs(matrix, new Set(['wi:1']))).toHaveLength(1);
  });

  it('ignores bugs that are not selected', () => {
    const matrix = matrixOf([
      bug('wi:1', [fix('packout', 1, [ORIGIN, { branch: 'release/26.5.1.0', status: 'NOT_STARTED' }])]),
      bug('wi:2', [fix('packout', 2, [ORIGIN, { branch: 'release/26.5.1.0', status: 'NOT_STARTED' }])]),
    ]);

    const jobs = planJobs(matrix, new Set(['wi:2']));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].pullRequestId).toBe(2);
  });

  it('produces no duplicate (repo, pr, target) triples', () => {
    const matrix = matrixOf([
      bug('wi:1', [
        fix('packout', 1, [
          ORIGIN,
          { branch: 'release/26.5.1.0', status: 'NOT_STARTED' },
          { branch: 'release/26.8.1.0', status: 'NOT_STARTED' },
        ]),
      ]),
    ]);

    const jobs = planJobs(matrix, new Set(['wi:1']));
    const keys = jobs.map(jobKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

const COLUMNS = [
  { branchName: 'release/26.2.1.0', versionLabel: '26.2', stageLabel: '0', sortOrder: 1 },
  { branchName: 'release/26.5.1.PRE', versionLabel: '26.5', stageLabel: 'PRE', sortOrder: 2 },
  { branchName: 'release/26.8.1.0', versionLabel: '26.8', stageLabel: '0', sortOrder: 5 },
];

const job = (repository: string, prId: number, targetBranch: string) => ({
  repository,
  pullRequestId: prId,
  targetBranch,
  bugTitle: 'a bug',
  workItemId: 1444759,
});

describe('groupJobsByBranch', () => {
  it('groups by target release in configured column order', () => {
    const groups = groupJobsByBranch(
      [
        job('packout', 1, 'release/26.8.1.0'),
        job('packout', 1, 'release/26.2.1.0'),
        job('core-sqldatabase', 2, 'release/26.5.1.PRE'),
      ],
      COLUMNS,
    );

    expect(groups.map((group) => group.targetBranch)).toEqual([
      'release/26.2.1.0',
      'release/26.5.1.PRE',
      'release/26.8.1.0',
    ]);
  });

  it('labels a group with the version and stage', () => {
    const groups = groupJobsByBranch([job('packout', 1, 'release/26.5.1.PRE')], COLUMNS);
    expect(groups[0].label).toBe('26.5 PRE');
  });

  it('collects every repository under one release', () => {
    const groups = groupJobsByBranch(
      [job('packout', 1, 'release/26.2.1.0'), job('core-sqldatabase', 2, 'release/26.2.1.0')],
      COLUMNS,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].jobs.map((item) => item.repository)).toEqual([
      'core-sqldatabase',
      'packout',
    ]);
  });

  it('falls back to the branch name for an unconfigured release', () => {
    const groups = groupJobsByBranch([job('packout', 1, 'release/27.1.1.0')], COLUMNS);
    expect(groups[0].label).toBe('27.1.1.0');
  });
});

describe('applySelection', () => {
  const jobs = [
    job('packout', 1, 'release/26.2.1.0'),
    job('core-sqldatabase', 2, 'release/26.2.1.0'),
    job('packout', 1, 'release/26.5.1.PRE'),
  ];

  it('selects everything when nothing is deselected', () => {
    expect(applySelection(jobs, new Set())).toHaveLength(3);
  });

  it('removes only the deselected job', () => {
    const result = applySelection(jobs, new Set([jobKey(jobs[0])]));
    expect(result).toHaveLength(2);
    expect(result).not.toContainEqual(jobs[0]);
  });

  it('can exclude a whole release without touching others', () => {
    const excluded = new Set(
      jobs.filter((item) => item.targetBranch === 'release/26.2.1.0').map(jobKey),
    );
    const result = applySelection(jobs, excluded);
    expect(result).toHaveLength(1);
    expect(result[0].targetBranch).toBe('release/26.5.1.PRE');
  });

  it('can exclude everything', () => {
    expect(applySelection(jobs, new Set(jobs.map(jobKey)))).toHaveLength(0);
  });

  it('distinguishes the same PR targeting different releases', () => {
    // packout !1 appears twice, for two releases; deselecting one must not
    // deselect the other.
    const result = applySelection(jobs, new Set([jobKey(jobs[2])]));
    expect(result.map((item) => item.targetBranch)).toEqual([
      'release/26.2.1.0',
      'release/26.2.1.0',
    ]);
  });
});
