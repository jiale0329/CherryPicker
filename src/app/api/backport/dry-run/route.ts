import { z } from 'zod';

import { prisma } from '@/lib/prisma/client';
import { handle, ok, parseBody } from '@/lib/validation/http';
import type { BackportReport } from '@/services/backport/engine';
import { runAll, summariseBatch, type BatchSummary } from '@/services/backport/queue';
import { bootstrap } from '@/services/config/bootstrap';

export const dynamic = 'force-dynamic';

const itemSchema = z.object({
  repository: z.string().min(1),
  pullRequestId: z.number().int().positive(),
  targetBranch: z.string().min(1),
});

/**
 * Rehearses backports without writing anything.
 *
 * Does the real work - fetches the mirror, resolves the commit that actually
 * landed, checks for duplicates, applies the cherry-pick in an isolated
 * worktree - then reports the diff or conflicts and discards the worktree.
 * Nothing is pushed and no pull request is created.
 *
 * There is deliberately no flag here that turns this into a write. Executing
 * for real lives at /api/backport/execute and requires an explicit confirm
 * value, so no payload typo can promote a rehearsal into a pull request.
 */
const bodySchema = z.union([
  itemSchema.transform((item) => ({ items: [item] })),
  z.object({ items: z.array(itemSchema).min(1).max(50) }),
]);

/** Single item returns the bare report; a batch returns a summary. */
type DryRunResponse =
  | BackportReport
  | { summary: BatchSummary; reports: (BackportReport | { error: string | null })[] };

export async function POST(request: Request) {
  return handle('backport.dry-run', async () => {
    const parsed = await parseBody(request, bodySchema);
    if (!parsed.ok) return parsed.response;

    await bootstrap();
    const config = await prisma.appConfig.findFirst();

    const results = await runAll(
      parsed.data.items.map((item) => ({
        repositoryName: item.repository,
        originalPrId: item.pullRequestId,
        targetBranch: item.targetBranch,
        dryRun: true,
      })),
      { concurrency: config?.concurrency ?? 3 },
    );

    // A single-item request keeps returning the bare report, which the existing
    // diagnostics and the detail panel rely on.
    if (results.length === 1 && results[0].report) {
      return ok<DryRunResponse>(results[0].report);
    }

    return ok<DryRunResponse>({
      summary: summariseBatch(results),
      reports: results.map((result) => result.report ?? { error: result.error }),
    });
  });
}
