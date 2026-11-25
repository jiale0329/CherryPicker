import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/prisma/client';
import type { BackportOutcome, BackportStep } from '@/services/backport/engine';
import type { BackportStatus } from '@/types/backport/status';

const log = createLogger('backport-jobs');

/**
 * Persistence for backport executions.
 *
 * The database records what ADO cannot tell us: that an attempt happened, what
 * it decided, and why it failed. ADO stays authoritative for pull request state,
 * so a saved PR_CREATED is never trusted over a live read - the matrix resolves
 * cells from ADO first and falls back to these records.
 *
 * Uniqueness is on (repository, original PR, target branch), so a retry updates
 * one row instead of accumulating history that has to be deduplicated later.
 */

/** Maps an engine outcome to the status the dashboard displays. */
export function statusForOutcome(outcome: BackportOutcome, pushed: boolean, prId?: number | null): BackportStatus {
  switch (outcome) {
    case 'SKIPPED_ALREADY_PRESENT':
      return 'SKIPPED';
    case 'CONFLICT':
      return 'CONFLICT';
    case 'PLAN_REFUSED':
    case 'FAILED':
      return 'FAILED';
    case 'PR_CREATED':
      return 'PR_CREATED';
    case 'PUSHED':
      return 'CHERRY_PICKED';
    case 'NEEDS_REVIEW':
    case 'DRY_RUN_CLEAN':
      // A dry run deliberately leaves no trace of progress: nothing was pushed,
      // so the cell must stay actionable rather than look half-done.
      if (prId) return 'PR_CREATED';
      return pushed ? 'CHERRY_PICKED' : 'NOT_STARTED';
    default:
      return 'FAILED';
  }
}

export interface JobIdentity {
  jobId: string;
  repositoryName: string;
  adoRepositoryId: string;
  originalPrId: number;
  targetBranch: string;
}

export interface JobSeed extends JobIdentity {
  originalPrTitle: string;
  originalPrAuthor: string;
  sourceBranch: string;
  mergeStrategy: string;
  pickCommitSha: string;
  pickParentCount: number;
  workItemIds: number[];
  correlationKey: string | null;
}

/**
 * Creates or reopens the job row before any work starts, so an interrupted
 * process still leaves a trace rather than vanishing.
 */
export async function beginJob(seed: JobSeed): Promise<void> {
  await prisma.backportJob.upsert({
    where: {
      adoRepositoryId_originalPrId_targetBranch: {
        adoRepositoryId: seed.adoRepositoryId,
        originalPrId: seed.originalPrId,
        targetBranch: seed.targetBranch,
      },
    },
    create: {
      id: seed.jobId,
      repositoryName: seed.repositoryName,
      adoRepositoryId: seed.adoRepositoryId,
      originalPrId: seed.originalPrId,
      originalPrTitle: seed.originalPrTitle,
      originalPrAuthor: seed.originalPrAuthor,
      sourceBranch: seed.sourceBranch,
      targetBranch: seed.targetBranch,
      workItemIdsJson: JSON.stringify(seed.workItemIds),
      correlationKey: seed.correlationKey,
      mergeStrategy: seed.mergeStrategy,
      pickCommitSha: seed.pickCommitSha,
      pickParentCount: seed.pickParentCount,
      status: 'PROCESSING',
      attempt: 1,
      startedAt: new Date(),
    },
    update: {
      status: 'PROCESSING',
      attempt: { increment: 1 },
      startedAt: new Date(),
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      conflictFilesJson: null,
      mergeStrategy: seed.mergeStrategy,
      pickCommitSha: seed.pickCommitSha,
      pickParentCount: seed.pickParentCount,
    },
  });
}

/** Resolves the row id for a (repo, PR, target) triple. */
async function rowIdFor(identity: {
  adoRepositoryId: string;
  originalPrId: number;
  targetBranch: string;
}): Promise<string | null> {
  const row = await prisma.backportJob.findUnique({
    where: {
      adoRepositoryId_originalPrId_targetBranch: {
        adoRepositoryId: identity.adoRepositoryId,
        originalPrId: identity.originalPrId,
        targetBranch: identity.targetBranch,
      },
    },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function appendLogs(
  identity: { adoRepositoryId: string; originalPrId: number; targetBranch: string },
  steps: readonly BackportStep[],
): Promise<void> {
  const jobId = await rowIdFor(identity);
  if (!jobId || steps.length === 0) return;

  await prisma.backportJobLog.createMany({
    data: steps.map((step) => ({
      jobId,
      level: step.ok ? 'info' : 'error',
      step: step.step,
      message: step.detail,
    })),
  });
}

export interface JobCompletion {
  status: BackportStatus;
  backportBranch?: string | null;
  targetPrId?: number | null;
  targetPrUrl?: string | null;
  conflictFiles?: readonly string[];
  errorCode?: string | null;
  errorMessage?: string | null;
}

export async function completeJob(
  identity: { adoRepositoryId: string; originalPrId: number; targetBranch: string },
  completion: JobCompletion,
): Promise<void> {
  const jobId = await rowIdFor(identity);
  if (!jobId) return;

  await prisma.backportJob.update({
    where: { id: jobId },
    data: {
      status: completion.status,
      backportBranch: completion.backportBranch ?? undefined,
      targetPrId: completion.targetPrId ?? undefined,
      targetPrUrl: completion.targetPrUrl ?? undefined,
      conflictFilesJson: completion.conflictFiles?.length
        ? JSON.stringify(completion.conflictFiles)
        : null,
      errorCode: completion.errorCode ?? null,
      errorMessage: completion.errorMessage ?? null,
      finishedAt: new Date(),
    },
  });

  log.info('job completed', {
    jobId,
    status: completion.status,
    targetPrId: completion.targetPrId ?? null,
  });
}

/**
 * Marks jobs left mid-flight by a crash or restart.
 *
 * A job row is written before work begins, so a process killed during a
 * cherry-pick leaves PROCESSING behind forever. Without this sweep the
 * dashboard would show a permanently spinning cell that no retry can clear.
 */
export async function reconcileInterruptedJobs(): Promise<number> {
  const stuck = await prisma.backportJob.findMany({
    where: { status: 'PROCESSING' },
    select: { id: true, repositoryName: true, originalPrId: true, targetBranch: true },
  });

  if (stuck.length === 0) return 0;

  await prisma.backportJob.updateMany({
    where: { id: { in: stuck.map((job) => job.id) } },
    data: {
      status: 'FAILED',
      errorCode: 'INTERRUPTED',
      errorMessage:
        'The job was still running when the server stopped. Nothing was pushed by a ' +
        'partially completed run; retry when ready.',
      finishedAt: new Date(),
    },
  });

  log.warn('reconciled interrupted jobs', { count: stuck.length });
  return stuck.length;
}
