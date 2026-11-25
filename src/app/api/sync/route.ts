import { z } from 'zod';

import { handle, ok, parseBody } from '@/lib/validation/http';
import { syncAllRepositories, syncRepository, type SyncResult } from '@/services/ado/sync';
import { refreshWatchlist } from '@/services/backport/watchlist';
import { bootstrap } from '@/services/config/bootstrap';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** Omit to refresh every tracked repository. */
  repository: z.string().min(1).optional(),
  /**
   * `watchlist` re-fetches only pinned bugs, which is seconds rather than a
   * minute. `full` additionally runs the branch-scoped sync that discovers
   * backports nobody pinned.
   */
  mode: z.enum(['watchlist', 'full']).default('full'),
});

/**
 * Re-reads completed pull requests, and the state of their work items, from ADO.
 *
 * POST rather than GET because it writes the cache. With no repository selector
 * in the UI, the default is to refresh all tracked repositories; passing one
 * narrows it for a targeted retry.
 */
interface SyncResponse {
  mode: 'watchlist' | 'full';
  repositories: number;
  pullRequests: number;
  workItems: number;
  watchedBugs: number;
  errors: { repository: string; branch: string; message: string }[];
  details: SyncResult[];
}

export async function POST(request: Request) {
  return handle('sync', async () => {
    const parsed = await parseBody(request, bodySchema);
    if (!parsed.ok) return parsed.response;

    await bootstrap();

    // Pinned bugs are always refreshed: they are the default view, and the
    // work-item-first fetch is authoritative for them.
    const watchlist = await refreshWatchlist();

    if (parsed.data.mode === 'watchlist') {
      return ok<SyncResponse>({
        mode: 'watchlist',
        repositories: 0,
        pullRequests: watchlist.reduce((total, result) => total + result.cached, 0),
        workItems: watchlist.length,
        watchedBugs: watchlist.length,
        errors: [] as { repository: string; branch: string; message: string }[],
        details: [],
      });
    }

    const results = parsed.data.repository
      ? [await syncRepository(parsed.data.repository)]
      : await syncAllRepositories();

    return ok<SyncResponse>({
      mode: 'full',
      repositories: results.length,
      pullRequests: results.reduce((total, result) => total + result.pullRequests, 0),
      workItems: results.reduce((total, result) => total + result.workItems, 0),
      watchedBugs: watchlist.length,
      errors: results.flatMap((result) =>
        result.errors.map((error) => ({ repository: result.repositoryName, ...error })),
      ),
      details: results,
    });
  });
}
