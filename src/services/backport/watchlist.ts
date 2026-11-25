import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/prisma/client';
import { syncBackportPullRequests } from '@/services/ado/backportPrSync';
import { AdoClient } from '@/services/ado/client';
import {
  fetchWorkItemPullRequests,
  type WorkItemFetchResult,
} from '@/services/ado/workItemPullRequests';

const log = createLogger('watchlist');

/**
 * The watchlist: bugs the developer has pinned.
 *
 * Adding one performs a work-item-first fetch immediately, so the bug has data
 * behind it straight away rather than waiting for the next full sync. This also
 * means a bug outside the branch-scoped sync's reach can still be tracked.
 */

export interface WatchlistEntry {
  workItemId: number;
  note: string | null;
  addedAt: string;
  lastFetchedAt: string | null;
  lastPrCount: number;
  /** From the work item cache, when known. */
  title: string | null;
  state: string | null;
  workItemType: string | null;
  assignedTo: string | null;
}

export async function listWatchlist(): Promise<WatchlistEntry[]> {
  const watched = await prisma.watchedBug.findMany({ orderBy: { addedAt: 'desc' } });
  if (watched.length === 0) return [];

  const details = await prisma.workItemCache.findMany({
    where: { id: { in: watched.map((bug) => bug.workItemId) } },
  });
  const byId = new Map(details.map((item) => [item.id, item]));

  return watched.map((bug) => {
    const detail = byId.get(bug.workItemId);
    return {
      workItemId: bug.workItemId,
      note: bug.note,
      addedAt: bug.addedAt.toISOString(),
      lastFetchedAt: bug.lastFetchedAt?.toISOString() ?? null,
      lastPrCount: bug.lastPrCount,
      title: detail?.title ?? null,
      state: detail?.state ?? null,
      workItemType: detail?.workItemType ?? null,
      assignedTo: detail?.assignedTo ?? null,
    };
  });
}

export interface AddResult {
  entry: WatchlistEntry;
  fetch: WorkItemFetchResult;
  /** True when the bug was already on the list and has been refreshed. */
  alreadyWatched: boolean;
}

export async function addToWatchlist(workItemId: number, note?: string): Promise<AddResult> {
  const existing = await prisma.watchedBug.findUnique({ where: { workItemId } });

  // Fetch before writing the entry, so a bad work item id does not leave a
  // watchlist row with nothing behind it.
  const fetch = await fetchWorkItemPullRequests(AdoClient.fromEnv(), workItemId);

  await prisma.watchedBug.upsert({
    where: { workItemId },
    create: {
      workItemId,
      note: note ?? null,
      lastFetchedAt: new Date(),
      lastPrCount: fetch.cached,
    },
    update: {
      ...(note !== undefined ? { note } : {}),
      lastFetchedAt: new Date(),
      lastPrCount: fetch.cached,
    },
  });

  const entries = await listWatchlist();
  const entry = entries.find((item) => item.workItemId === workItemId);
  if (!entry) throw new Error(`Could not read back watchlist entry ${workItemId}`);

  log.info(existing ? 'refreshed watched bug' : 'added watched bug', {
    workItemId,
    linked: fetch.linked,
    cached: fetch.cached,
  });

  return { entry, fetch, alreadyWatched: existing !== null };
}

/**
 * Unpins a bug.
 *
 * Only the watchlist row is removed. Cached pull requests stay, so the bug
 * remains visible in the all-bugs view and nothing has to be re-fetched if it
 * is pinned again. Deleting the cache here would quietly destroy audit data.
 */
export async function removeFromWatchlist(workItemId: number): Promise<boolean> {
  const deleted = await prisma.watchedBug.deleteMany({ where: { workItemId } });
  if (deleted.count > 0) log.info('removed watched bug', { workItemId });
  return deleted.count > 0;
}

/** Re-fetches every watched bug. Used by the dashboard's refresh. */
export async function refreshWatchlist(): Promise<WorkItemFetchResult[]> {
  const watched = await prisma.watchedBug.findMany({ orderBy: { addedAt: 'asc' } });
  const client = AdoClient.fromEnv();
  const results: WorkItemFetchResult[] = [];

  // Re-read the pull requests this tool created first. Abandoning one removes
  // its work item links, so the work-item fetch alone would not see it and a
  // stale PR_CREATED record would keep the cell looking done.
  await syncBackportPullRequests().catch((error) => {
    log.warn('could not refresh created pull requests', { error: (error as Error).message });
    return null;
  });

  for (const bug of watched) {
    try {
      const fetch = await fetchWorkItemPullRequests(client, bug.workItemId);
      await prisma.watchedBug.update({
        where: { workItemId: bug.workItemId },
        data: { lastFetchedAt: new Date(), lastPrCount: fetch.cached },
      });
      results.push(fetch);
    } catch (error) {
      // One unreadable work item must not stop the rest.
      log.warn('could not refresh watched bug', {
        workItemId: bug.workItemId,
        error: (error as Error).message,
      });
    }
  }

  return results;
}

export async function getWatchedIds(): Promise<Set<number>> {
  const watched = await prisma.watchedBug.findMany({ select: { workItemId: true } });
  return new Set(watched.map((bug) => bug.workItemId));
}
