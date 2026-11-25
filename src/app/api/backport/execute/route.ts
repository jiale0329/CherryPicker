import { z } from 'zod';

import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/prisma/client';
import { fail, handle, ok, parseBody } from '@/lib/validation/http';
import { runAll, summariseBatch } from '@/services/backport/queue';
import { bootstrap } from '@/services/config/bootstrap';

export const dynamic = 'force-dynamic';

const log = createLogger('backport-execute');

const itemSchema = z.object({
  repository: z.string().min(1),
  pullRequestId: z.number().int().positive(),
  targetBranch: z.string().min(1),
});

/**
 * Executes backports for real: pushes the backport branch and opens a pull
 * request for each item.
 *
 * `confirm: "create-pull-requests"` is required. This is the only route in the
 * application that writes to Azure DevOps, and the effects are visible to the
 * team - reviewers are notified and two build validations are queued per PR -
 * so an accidental or malformed request must not be enough to trigger it.
 *
 * Jobs are isolated: a conflict in one repository does not abandon the rest.
 */
const bodySchema = z.object({
  items: z.array(itemSchema).min(1).max(50),
  confirm: z.literal('create-pull-requests'),
});

export async function POST(request: Request) {
  return handle('backport.execute', async () => {
    const parsed = await parseBody(request, bodySchema);
    if (!parsed.ok) return parsed.response;

    await bootstrap();

    const config = await prisma.appConfig.findFirst();
    if (!config) return fail('NOT_CONFIGURED', 'Configuration has not been initialised.', 500);

    // Duplicate (repository, PR, target) triples would race on the same job row
    // and the same backport branch.
    const seen = new Set<string>();
    for (const item of parsed.data.items) {
      const key = `${item.repository}::${item.pullRequestId}::${item.targetBranch}`;
      if (seen.has(key)) {
        return fail('INVALID_REQUEST', `Duplicate item in request: ${key}`, 400);
      }
      seen.add(key);
    }

    log.warn('executing backports for real', {
      items: parsed.data.items.length,
      concurrency: config.concurrency,
    });

    const results = await runAll(
      parsed.data.items.map((item) => ({
        repositoryName: item.repository,
        originalPrId: item.pullRequestId,
        targetBranch: item.targetBranch,
        dryRun: false,
      })),
      { concurrency: config.concurrency },
    );

    return ok({
      summary: summariseBatch(results),
      results: results.map((result) => ({
        repository: result.input.repositoryName,
        pullRequestId: result.input.originalPrId,
        targetBranch: result.input.targetBranch,
        outcome: result.report?.outcome ?? 'FAILED',
        backportBranch: result.report?.backportBranch ?? null,
        targetPrId: result.report?.targetPrId ?? null,
        targetPrUrl: result.report?.targetPrUrl ?? null,
        conflictFiles: result.report?.conflictFiles ?? [],
        warnings: result.report?.warnings ?? [],
        error: result.error ?? result.report?.errorMessage ?? null,
      })),
    });
  });
}
