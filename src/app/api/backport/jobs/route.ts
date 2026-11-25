import { z } from 'zod';

import { prisma } from '@/lib/prisma/client';
import { handle, ok, parseQuery } from '@/lib/validation/http';
import { bootstrap } from '@/services/config/bootstrap';
import { BACKPORT_STATUSES } from '@/types/backport/status';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  repository: z.string().optional(),
  status: z.string().optional(),
  /** Include the execution log, which is verbose, so it is opt-in. */
  withLogs: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Backport execution history, newest first. Feeds the history page. */
export async function GET(request: Request) {
  return handle('backport.jobs', async () => {
    const parsed = parseQuery(request, querySchema);
    if (!parsed.ok) return parsed.response;

    await bootstrap();

    const statuses = parsed.data.status
      ?.split(',')
      .map((part) => part.trim())
      .filter((part): part is (typeof BACKPORT_STATUSES)[number] =>
        (BACKPORT_STATUSES as readonly string[]).includes(part),
      );

    const jobs = await prisma.backportJob.findMany({
      where: {
        ...(parsed.data.repository ? { repositoryName: parsed.data.repository } : {}),
        ...(statuses?.length ? { status: { in: statuses } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: parsed.data.limit,
      // Always included so the row type stays concrete; `take: 0` keeps the
      // payload small when logs were not requested.
      include: { logs: { orderBy: { ts: 'asc' }, take: parsed.data.withLogs ? 200 : 0 } },
    });

    return ok({
      jobs: jobs.map((job) => ({
        id: job.id,
        repositoryName: job.repositoryName,
        originalPrId: job.originalPrId,
        originalPrTitle: job.originalPrTitle,
        originalPrAuthor: job.originalPrAuthor,
        sourceBranch: job.sourceBranch,
        targetBranch: job.targetBranch,
        backportBranch: job.backportBranch,
        targetPrId: job.targetPrId,
        targetPrUrl: job.targetPrUrl,
        status: job.status,
        attempt: job.attempt,
        mergeStrategy: job.mergeStrategy,
        pickCommitSha: job.pickCommitSha,
        conflictFiles: parseJson(job.conflictFilesJson),
        workItemIds: parseJson(job.workItemIdsJson),
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        createdAt: job.createdAt.toISOString(),
        startedAt: job.startedAt?.toISOString() ?? null,
        finishedAt: job.finishedAt?.toISOString() ?? null,
        logs: parsed.data.withLogs
          ? job.logs.map((entry) => ({
            ts: entry.ts.toISOString(),
            level: entry.level,
            step: entry.step,
            message: entry.message,
          }))
          : undefined,
      })),
    });
  });
}

function parseJson(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
