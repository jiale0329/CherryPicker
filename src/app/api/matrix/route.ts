import { z } from 'zod';

import { prisma } from '@/lib/prisma/client';
import { handle, ok, parseQuery } from '@/lib/validation/http';
import { getExistingBranchesByRepository } from '@/services/ado/sync';
import { buildMatrix } from '@/services/backport/matrix';
import { getWatchedIds } from '@/services/backport/watchlist';
import { bootstrap } from '@/services/config/bootstrap';
import { isRowCategory } from '@/types/backport/category';
import { MATRIX_CELL_STATUSES } from '@/types/backport/status';

export const dynamic = 'force-dynamic';

const csv = (value: string | undefined): string[] | undefined =>
  value
    ? value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    : undefined;

const querySchema = z.object({
  /** Optional narrowing; the dashboard shows all tracked repositories. */
  repository: z.string().optional(),
  search: z.string().optional(),
  /** Optional category narrowing, e.g. MINE_OPEN. Omit to show everything. */
  category: z.string().optional(),
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  outstanding: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  /** `watchlist` (default) or `all`. */
  scope: z.enum(['watchlist', 'all']).default('watchlist'),
  excludeStates: z.string().optional(),
  includeStates: z.string().optional(),
  status: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
          .split(',')
          .map((part) => part.trim())
          .filter((part): part is (typeof MATRIX_CELL_STATUSES)[number] =>
            (MATRIX_CELL_STATUSES as readonly string[]).includes(part),
          )
        : undefined,
    ),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(25),
});

export async function GET(request: Request) {
  return handle('matrix', async () => {
    const parsed = parseQuery(request, querySchema);
    if (!parsed.ok) return parsed.response;

    await bootstrap();

    const config = await prisma.appConfig.findFirst();

    // Presence is checked on the raw query string, not the parsed value, so
    // `excludeStates=` means "exclude nothing" rather than "use the default".
    const supplied = new URL(request.url).searchParams.has('excludeStates');
    let excludeStates = supplied ? (csv(parsed.data.excludeStates) ?? []) : undefined;

    if (excludeStates === undefined && config) {
      try {
        const stored = JSON.parse(config.excludedWorkItemStatesJson) as unknown;
        if (Array.isArray(stored)) {
          excludeStates = stored.filter((state): state is string => typeof state === 'string');
        }
      } catch {
        excludeStates = undefined;
      }
    }

    let closedStates: string[] | undefined;
    if (config) {
      try {
        const stored = JSON.parse(config.closedWorkItemStatesJson) as unknown;
        if (Array.isArray(stored)) {
          closedStates = stored.filter((state): state is string => typeof state === 'string');
        }
      } catch {
        closedStates = undefined;
      }
    }

    const existingBranchesByRepo = await getExistingBranchesByRepository();
    const watchedWorkItemIds = await getWatchedIds();

    const matrix = await buildMatrix({
      existingBranchesByRepo,
      watchedWorkItemIds,
      watchlistOnly: parsed.data.scope === 'watchlist',
      repositoryFilter: parsed.data.repository,
      search: parsed.data.search,
      currentUserId: config?.adoUserId ?? null,
      currentUserDisplayName: config?.adoUserDisplayName ?? null,
      closedWorkItemStates: closedStates,
      categoryFilter: csv(parsed.data.category)?.filter(isRowCategory),
      onlyAuthorId: parsed.data.mine ? (config?.adoUserId ?? undefined) : undefined,
      onlyOutstanding: parsed.data.outstanding,
      excludeWorkItemStates: excludeStates,
      includeWorkItemStates: csv(parsed.data.includeStates),
      statusFilter: parsed.data.status,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });

    return ok(matrix);
  });
}
