/**
 * Correlating "the same fix" across release branches.
 *
 * Cherry-picking rewrites the commit sha, so sha equality cannot answer whether
 * a fix reached a release. Phase 0 found a much better key: every completed PR
 * in the tracked repositories uses a `hotfix/{workItemId}-{slug}` source branch
 * (853 of 853 parsed, 848 `hotfix/`, 5 `feature/`).
 *
 * Evidence is ranked rather than collapsed into a boolean, because the brief is
 * explicit that a similar-looking patch must not be reported as merged. A
 * patch-id match produces a *hint* on an otherwise NOT_STARTED cell, never a
 * green one.
 */

import type { BackportStatus, MatrixCellStatus } from '@/types/backport/status';

export type EvidenceConfidence = 'definitive' | 'strong' | 'weak';

export type EvidenceSource =
  | 'execution-record'
  | 'backport-branch-name'
  | 'work-item'
  | 'commit-trailer'
  | 'patch-id'
  | 'ancestry';

export interface Evidence {
  source: EvidenceSource;
  confidence: EvidenceConfidence;
  detail: string;
}

/** `hotfix/1507096-external-oktostart-api-issue` -> `1507096` */
const WORK_ITEM_BRANCH = /^(?:hotfix|feature|bugfix|fix)\/(\d{4,})(?:[-_/].*)?$/i;

/** Branches this tool creates: `backport/PR-1842-26.5.1.PRE` */
const BACKPORT_BRANCH = /^backport\/PR-(\d+)-(.+)$/i;

/** `(cherry picked from commit abc123...)` trailer written by `cherry-pick -x` */
const CHERRY_PICK_TRAILER = /\(cherry picked from commit ([0-9a-f]{7,40})\)/gi;

export function parseWorkItemKey(sourceBranch: string): string | null {
  const match = WORK_ITEM_BRANCH.exec(stripRef(sourceBranch));
  return match ? match[1] : null;
}

export interface BackportBranchInfo {
  originalPrId: number;
  targetSlug: string;
}

export function parseBackportBranch(branch: string): BackportBranchInfo | null {
  const match = BACKPORT_BRANCH.exec(stripRef(branch));
  if (!match) return null;
  return { originalPrId: Number(match[1]), targetSlug: match[2] };
}

export function parseCherryPickTrailers(commitMessage: string): string[] {
  const found: string[] = [];
  for (const match of commitMessage.matchAll(CHERRY_PICK_TRAILER)) found.push(match[1]);
  return found;
}

function stripRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

/**
 * Converts a pull request title into a branch-safe slug.
 *
 * Any leading `… | version |` tag is dropped first, so the slug describes the
 * fix rather than repeating the repository and release. Length is capped
 * because the full branch name also carries the work item id and the target
 * release, and Windows has a 260-character path limit that worktree paths
 * have to live within.
 */
export function slugifyTitle(title: string, maxLength = 60): string {
  const withoutTag = title.includes('|')
    ? (title.split('|').at(-1) ?? title)
    : title;

  const slug = withoutTag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (slug.length <= maxLength) return slug || 'fix';

  // Cut on a word boundary so the name stays readable.
  const clipped = slug.slice(0, maxLength);
  const lastDash = clipped.lastIndexOf('-');
  return (lastDash > maxLength / 2 ? clipped.slice(0, lastDash) : clipped) || 'fix';
}

export interface BranchNameValues {
  prId: number;
  targetBranch: string;
  /** Work item id from the original branch, when known. */
  workItemId?: string | number | null;
  /** Short description of the fix, slugified. */
  title?: string;
}

/**
 * Builds the backport branch name from the configured template.
 *
 * The team's convention is
 * `hotfix/{workItemId}-{slug}-on-release-{targetSlug}`, which matches where
 * they put every other fix branch. The `-on-release-{targetSlug}` part is not
 * decoration: without it, backporting one work item to several releases would
 * generate the same branch name each time, and would also collide with the
 * original fix branch. Overwriting an existing branch is forbidden, so the
 * name has to be distinct per target.
 */
export function buildBackportBranchName(template: string, values: BranchNameValues): string {
  const targetSlug = stripRef(values.targetBranch)
    .replace(/^release\//, '')
    .replace(/[^\w.\-]+/g, '-');

  const workItemId =
    values.workItemId !== null && values.workItemId !== undefined
      ? String(values.workItemId)
      : `PR-${values.prId}`;

  const slug = values.title ? slugifyTitle(values.title) : 'fix';

  return template
    .replace(/\{prId\}/g, String(values.prId))
    .replace(/\{workItemId\}/g, workItemId)
    .replace(/\{slug\}/g, slug)
    .replace(/\{targetSlug\}/g, targetSlug)
    .replace(/\{targetBranch\}/g, stripRef(values.targetBranch));
}

// ---------------------------------------------------------------------------
// Status resolution
// ---------------------------------------------------------------------------

export type TargetPrState = 'active' | 'completed' | 'abandoned';

export interface TargetPullRequestEvidence {
  pullRequestId: number;
  state: TargetPrState;
  /**
   * True when a non-group reviewer has voted 10 or 5. Group votes are excluded
   * because the blocking "minimum reviewers" policy on these branches does not
   * count the creator and is satisfied by an individual.
   */
  approvedByIndividual: boolean;
  source: EvidenceSource;
  confidence: EvidenceConfidence;
}

export interface CellEvidenceInput {
  /** False when the release branch does not exist in this repository. */
  branchExists: boolean;
  /** Our own execution record, if a job has ever run for this pair. */
  job?: {
    status: BackportStatus;
    targetPrId?: number | null;
  } | null;
  /** PRs into the target branch that appear to carry this fix. */
  targetPullRequests?: readonly TargetPullRequestEvidence[];
  /** Result of a git patch-id / `git cherry` comparison, when computed. */
  patchMatch?: {
    present: boolean;
    detail: string;
  } | null;
  /** True when the exact original sha is an ancestor of the target branch. */
  shaIsAncestor?: boolean;
}

export interface CellResolution {
  status: MatrixCellStatus;
  confidence: EvidenceConfidence;
  evidence: Evidence[];
  /**
   * Set when something resembling the fix was found but the evidence is too
   * weak to call it done. The cell stays actionable and the detail panel
   * explains what was found, so the developer decides.
   */
  likelyAlreadyPresent: boolean;
  targetPrId?: number;
}

/**
 * Resolves one matrix cell from all available evidence.
 *
 * Precedence is deliberate:
 *   1. A branch that does not exist is not work.
 *   2. A completed target PR is definitive - the fix is in the release.
 *   3. A running job beats stale PR data.
 *   4. An open target PR reflects reality better than our last saved status.
 *   5. Otherwise fall back to the execution record.
 *   6. Patch-only evidence never marks a cell done.
 */
export function resolveCellStatus(input: CellEvidenceInput): CellResolution {
  const evidence: Evidence[] = [];

  if (!input.branchExists) {
    return {
      status: 'UNAVAILABLE',
      confidence: 'definitive',
      evidence: [
        {
          source: 'execution-record',
          confidence: 'definitive',
          detail: 'Release branch does not exist in this repository.',
        },
      ],
      likelyAlreadyPresent: false,
    };
  }

  const prs = input.targetPullRequests ?? [];

  if (input.shaIsAncestor) {
    evidence.push({
      source: 'ancestry',
      confidence: 'definitive',
      detail: 'The original commit is an ancestor of the target branch.',
    });
    return {
      status: 'MERGED',
      confidence: 'definitive',
      evidence,
      likelyAlreadyPresent: false,
    };
  }

  const completed = prs.find((pr) => pr.state === 'completed');
  if (completed) {
    evidence.push({
      source: completed.source,
      confidence: completed.confidence,
      detail: `PR !${completed.pullRequestId} into this branch is completed.`,
    });
    return {
      status: 'MERGED',
      confidence: completed.confidence,
      evidence,
      likelyAlreadyPresent: false,
      targetPrId: completed.pullRequestId,
    };
  }

  if (input.job?.status === 'PROCESSING') {
    evidence.push({
      source: 'execution-record',
      confidence: 'definitive',
      detail: 'A backport job is currently running.',
    });
    return { status: 'PROCESSING', confidence: 'definitive', evidence, likelyAlreadyPresent: false };
  }

  const active = prs.find((pr) => pr.state === 'active');
  if (active) {
    evidence.push({
      source: active.source,
      confidence: active.confidence,
      detail: `PR !${active.pullRequestId} is open against this branch.`,
    });
    return {
      status: active.approvedByIndividual ? 'PR_APPROVED' : 'PR_CREATED',
      confidence: active.confidence,
      evidence,
      likelyAlreadyPresent: false,
      targetPrId: active.pullRequestId,
    };
  }

  if (input.job) {
    const abandoned = prs.find((pr) => pr.state === 'abandoned');
    if (abandoned) {
      evidence.push({
        source: abandoned.source,
        confidence: abandoned.confidence,
        detail: `PR !${abandoned.pullRequestId} was abandoned; the backport needs redoing.`,
      });
      return {
        status: 'NOT_STARTED',
        confidence: 'strong',
        evidence,
        likelyAlreadyPresent: false,
      };
    }

    evidence.push({
      source: 'execution-record',
      confidence: 'definitive',
      detail: `Last job finished with status ${input.job.status}.`,
    });
    return {
      status: input.job.status,
      confidence: 'definitive',
      evidence,
      likelyAlreadyPresent: false,
      targetPrId: input.job.targetPrId ?? undefined,
    };
  }

  // No PR and no execution record. Patch evidence is a hint only: an equivalent
  // patch may be an unrelated change touching the same lines, or a partial
  // application. Reporting MERGED here is exactly what the brief rules out.
  if (input.patchMatch?.present) {
    evidence.push({
      source: 'patch-id',
      confidence: 'weak',
      detail: input.patchMatch.detail,
    });
    return {
      status: 'NOT_STARTED',
      confidence: 'weak',
      evidence,
      likelyAlreadyPresent: true,
    };
  }

  return {
    status: 'NOT_STARTED',
    confidence: 'strong',
    evidence: [
      {
        source: 'execution-record',
        confidence: 'strong',
        detail: 'No backport PR and no execution record for this release.',
      },
    ],
    likelyAlreadyPresent: false,
  };
}

/**
 * Whether a reviewer vote counts as an individual approval.
 * ADO votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting, -10 rejected.
 */
export function isIndividualApproval(reviewer: {
  vote: number;
  isContainer?: boolean | null;
}): boolean {
  if (reviewer.isContainer) return false;
  return reviewer.vote >= 5;
}
