import type { MatrixResult } from '@/services/backport/matrix';

/**
 * Turning a matrix selection into a concrete job list.
 *
 * Kept separate from the dialog component so it can be tested directly. This is
 * the last gate before a write, so it must only ever produce jobs for releases
 * that are expected, missing and actionable - never the origin release, never a
 * branch absent from that repository, and never one that already has an open
 * pull request.
 */

export interface BackportJobSpec {
  repository: string;
  pullRequestId: number;
  targetBranch: string;
  /** Display only. */
  bugTitle: string;
  workItemId: number | null;
}

/** Stable identity for a job, used as the selection key. */
export function jobKey(job: BackportJobSpec): string {
  return `${job.repository}::${job.pullRequestId}::${job.targetBranch}`;
}

/** Expands selected bugs into one candidate job per missing, actionable release. */
export function planJobs(matrix: MatrixResult, selected: ReadonlySet<string>): BackportJobSpec[] {
  const jobs: BackportJobSpec[] = [];

  for (const bug of matrix.rows) {
    if (!selected.has(bug.key)) continue;

    for (const fix of bug.fixes) {
      for (const cell of fix.cells) {
        if (!cell.expected || cell.isOrigin || !cell.actionable) continue;
        jobs.push({
          repository: fix.repositoryName,
          pullRequestId: fix.originPullRequestId,
          targetBranch: cell.branchName,
          bugTitle: bug.title,
          workItemId: bug.workItemId,
        });
      }
    }
  }

  return jobs;
}

export interface BranchGroup {
  targetBranch: string;
  /** e.g. "26.2 0" */
  label: string;
  jobs: BackportJobSpec[];
}

/**
 * Groups candidate jobs by target release, in the configured column order.
 *
 * Grouped by release rather than repository because the choice being made is
 * "which releases do I want pull requests for", and one release commonly spans
 * several repositories.
 */
export function groupJobsByBranch(
  jobs: readonly BackportJobSpec[],
  columns: MatrixResult['columns'],
): BranchGroup[] {
  const order = new Map(columns.map((column, index) => [column.branchName, index]));
  const labels = new Map(
    columns.map((column) => [column.branchName, `${column.versionLabel} ${column.stageLabel}`]),
  );

  const byBranch = new Map<string, BackportJobSpec[]>();
  for (const job of jobs) {
    const list = byBranch.get(job.targetBranch) ?? [];
    list.push(job);
    byBranch.set(job.targetBranch, list);
  }

  return [...byBranch.entries()]
    .sort(
      (a, b) => (order.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (order.get(b[0]) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(([targetBranch, groupJobs]) => ({
      targetBranch,
      label: labels.get(targetBranch) ?? targetBranch.replace(/^release\//, ''),
      jobs: [...groupJobs].sort((a, b) => a.repository.localeCompare(b.repository)),
    }));
}

/**
 * Applies the user's deselections.
 *
 * Modelled as an exclusion set so "everything is selected" is the natural
 * default with no initialisation step, and newly appearing candidates are
 * included rather than silently left out.
 */
export function applySelection(
  jobs: readonly BackportJobSpec[],
  deselected: ReadonlySet<string>,
): BackportJobSpec[] {
  return jobs.filter((job) => !deselected.has(jobKey(job)));
}
