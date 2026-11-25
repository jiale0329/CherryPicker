import { createLogger } from '@/lib/logging/logger';
import { runBackport, type BackportReport, type RunBackportInput } from '@/services/backport/engine';

const log = createLogger('backport-queue');

/**
 * Concurrency-limited job runner.
 *
 * Hand-rolled rather than p-queue: the requirement is a semaphore over a fixed
 * list, p-queue v8 is ESM-only which complicates bundling under Next, and the
 * logic below is small enough to read in one sitting.
 *
 * Each job is isolated. One failure never cancels the others, which the brief
 * requires for bulk operations - a conflict in one repository must not abandon
 * the backports queued for the rest.
 */

export interface QueuedResult {
  input: RunBackportInput;
  report: BackportReport | null;
  /** Set when the job threw before producing a report at all. */
  error: string | null;
}

export async function runAll(
  items: readonly RunBackportInput[],
  options: { concurrency: number },
): Promise<QueuedResult[]> {
  const concurrency = Math.max(1, Math.min(16, options.concurrency));
  const results: QueuedResult[] = items.map((input) => ({ input, report: null, error: null }));

  let cursor = 0;

  const worker = async (workerId: number): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      const input = items[index];
      log.info('job starting', {
        workerId,
        repository: input.repositoryName,
        originalPrId: input.originalPrId,
        targetBranch: input.targetBranch,
        dryRun: input.dryRun !== false,
      });

      try {
        results[index].report = await runBackport(input);
      } catch (error) {
        // Isolated on purpose: record and continue with the next job.
        results[index].error = (error as Error).message;
        log.error('job threw', {
          repository: input.repositoryName,
          originalPrId: input.originalPrId,
          targetBranch: input.targetBranch,
          error: results[index].error,
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, (_, id) => worker(id)),
  );

  return results;
}

export interface BatchSummary {
  total: number;
  prCreated: number;
  pushed: number;
  clean: number;
  skipped: number;
  conflicts: number;
  failed: number;
  needsReview: number;
}

export function summariseBatch(results: readonly QueuedResult[]): BatchSummary {
  const summary: BatchSummary = {
    total: results.length,
    prCreated: 0,
    pushed: 0,
    clean: 0,
    skipped: 0,
    conflicts: 0,
    failed: 0,
    needsReview: 0,
  };

  for (const result of results) {
    if (!result.report) {
      summary.failed += 1;
      continue;
    }
    switch (result.report.outcome) {
      case 'PR_CREATED':
        summary.prCreated += 1;
        break;
      case 'PUSHED':
        summary.pushed += 1;
        break;
      case 'DRY_RUN_CLEAN':
        summary.clean += 1;
        break;
      case 'NEEDS_REVIEW':
        summary.needsReview += 1;
        break;
      case 'SKIPPED_ALREADY_PRESENT':
        summary.skipped += 1;
        break;
      case 'CONFLICT':
        summary.conflicts += 1;
        break;
      default:
        summary.failed += 1;
    }
  }

  return summary;
}
