/**
 * Backport status model.
 *
 * This union is the single definition of status. SQLite has no enum, so the
 * database stores these as strings and this file constrains them.
 *
 * The critical rule: a successful cherry-pick is not a completed backport.
 * Only MERGED means the fix is actually present in the target release. Target
 * branches in this project carry blocking build and review policies, so
 * PR_CREATED is the expected resting state for a successful run, not a failure.
 */

export const BACKPORT_STATUSES = [
  'NOT_STARTED',
  'PROCESSING',
  'CHERRY_PICKED',
  'PR_CREATED',
  'PR_APPROVED',
  'MERGED',
  'CONFLICT',
  'FAILED',
  'SKIPPED',
] as const;

export type BackportStatus = (typeof BACKPORT_STATUSES)[number];

/**
 * A matrix cell can also represent a target branch that does not exist in the
 * repository at all. That is not a backport state, so it is modelled
 * separately: it must never be actionable or counted as outstanding work.
 */
export const MATRIX_CELL_STATUSES = [...BACKPORT_STATUSES, 'UNAVAILABLE'] as const;
export type MatrixCellStatus = (typeof MATRIX_CELL_STATUSES)[number];

export type StatusTone =
  | 'neutral'
  | 'progress'
  | 'intermediate'
  | 'success'
  | 'warning'
  | 'danger'
  | 'muted';

export interface StatusDescriptor {
  readonly status: MatrixCellStatus;
  readonly label: string;
  readonly tone: StatusTone;
  /** Tailwind token from the status ramp in globals.css. */
  readonly colorVar: string;
  readonly description: string;
  /** Counts toward "fully backported". Only true for MERGED. */
  readonly isComplete: boolean;
  /** Work remains for the developer. Drives the "outstanding" summary card. */
  readonly isOutstanding: boolean;
  /** Needs human intervention before it can progress. */
  readonly needsAttention: boolean;
}

export const STATUS_DESCRIPTORS: Record<MatrixCellStatus, StatusDescriptor> = {
  NOT_STARTED: {
    status: 'NOT_STARTED',
    label: 'Not Started',
    tone: 'neutral',
    colorVar: 'status-not-started',
    description: 'No backport has been attempted for this release.',
    isComplete: false,
    isOutstanding: true,
    needsAttention: false,
  },
  PROCESSING: {
    status: 'PROCESSING',
    label: 'Processing',
    tone: 'progress',
    colorVar: 'status-processing',
    description: 'A backport job is running.',
    isComplete: false,
    isOutstanding: true,
    needsAttention: false,
  },
  CHERRY_PICKED: {
    status: 'CHERRY_PICKED',
    label: 'Cherry-picked',
    tone: 'intermediate',
    colorVar: 'status-cherry-picked',
    description:
      'Commits applied and the backport branch was pushed, but no pull request exists yet.',
    isComplete: false,
    isOutstanding: true,
    needsAttention: true,
  },
  PR_CREATED: {
    status: 'PR_CREATED',
    label: 'PR Created',
    tone: 'intermediate',
    colorVar: 'status-pr-created',
    description: 'Pull request is open, awaiting builds and review.',
    isComplete: false,
    isOutstanding: true,
    needsAttention: false,
  },
  PR_APPROVED: {
    status: 'PR_APPROVED',
    label: 'PR Approved',
    tone: 'intermediate',
    colorVar: 'status-pr-approved',
    description: 'Pull request is approved but not yet merged.',
    isComplete: false,
    isOutstanding: true,
    needsAttention: false,
  },
  MERGED: {
    status: 'MERGED',
    label: 'Merged',
    tone: 'success',
    colorVar: 'status-merged',
    description: 'The fix is present in this release.',
    isComplete: true,
    isOutstanding: false,
    needsAttention: false,
  },
  CONFLICT: {
    status: 'CONFLICT',
    label: 'Conflict',
    tone: 'warning',
    colorVar: 'status-conflict',
    description: 'Cherry-pick stopped on a merge conflict and needs manual resolution.',
    isComplete: false,
    isOutstanding: true,
    needsAttention: true,
  },
  FAILED: {
    status: 'FAILED',
    label: 'Failed',
    tone: 'danger',
    colorVar: 'status-failed',
    description: 'The backport job failed. See the execution log.',
    isComplete: false,
    isOutstanding: true,
    needsAttention: true,
  },
  SKIPPED: {
    status: 'SKIPPED',
    label: 'Already Present',
    tone: 'muted',
    colorVar: 'status-skipped',
    description: 'An equivalent change was already found in this release.',
    isComplete: false,
    isOutstanding: false,
    needsAttention: false,
  },
  UNAVAILABLE: {
    status: 'UNAVAILABLE',
    label: 'No Branch',
    tone: 'muted',
    colorVar: 'status-unavailable',
    description: 'This release branch does not exist in this repository.',
    isComplete: false,
    isOutstanding: false,
    needsAttention: false,
  },
};

export function describeStatus(status: MatrixCellStatus): StatusDescriptor {
  return STATUS_DESCRIPTORS[status];
}

/**
 * Grid vocabulary: four marks, not eleven.
 *
 * All nine statuses are kept in the data, the tooltip and the detail drawer,
 * because the distinction between a cherry-pick and an open pull request
 * matters when deciding what to do about one cell. It does not matter when
 * scanning forty of them, and rendering eleven distinct labelled pills per
 * screen is what made the matrix hard to read.
 */
export type GridTone = 'done' | 'progress' | 'action' | 'none';

export function gridTone(status: MatrixCellStatus): GridTone {
  switch (status) {
    case 'MERGED':
      return 'done';
    case 'SKIPPED':
      // Nothing to do here, so it reads as settled rather than outstanding.
      return 'done';
    case 'PROCESSING':
    case 'CHERRY_PICKED':
    case 'PR_CREATED':
    case 'PR_APPROVED':
      return 'progress';
    case 'NOT_STARTED':
    case 'CONFLICT':
    case 'FAILED':
      return 'action';
    case 'UNAVAILABLE':
      return 'none';
  }
}

/** One colour per grid tone, so a row scans at a glance. */
export const GRID_TONE_COLOR: Record<GridTone, string> = {
  done: 'status-merged',
  progress: 'status-pr-created',
  action: 'status-conflict',
  none: 'status-unavailable',
};

/** True when a backport can be started or restarted for this cell. */
export function isActionable(status: MatrixCellStatus): boolean {
  return status === 'NOT_STARTED' || status === 'CONFLICT' || status === 'FAILED';
}

export function isBackportStatus(value: string): value is BackportStatus {
  return (BACKPORT_STATUSES as readonly string[]).includes(value);
}
