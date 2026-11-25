import { z } from 'zod';

import { fail, handle, ok, parseBody, parseQuery } from '@/lib/validation/http';
import { WorkItemNotFoundError } from '@/services/ado/workItemPullRequests';
import {
  addToWatchlist,
  listWatchlist,
  removeFromWatchlist,
  refreshWatchlist,
} from '@/services/backport/watchlist';
import { bootstrap } from '@/services/config/bootstrap';

export const dynamic = 'force-dynamic';

/** GET the pinned bugs. */
export async function GET() {
  return handle('watchlist.get', async () => {
    await bootstrap();
    return ok({ entries: await listWatchlist() });
  });
}

const addSchema = z.object({
  /** Accepts "1444759" or "#1444759", since both get pasted. */
  workItemId: z.union([
    z.number().int().positive(),
    z
      .string()
      .trim()
      .regex(/^#?\d+$/, 'Enter a work item number, for example 1444759')
      .transform((value) => Number(value.replace(/^#/, ''))),
  ]),
  note: z.string().trim().max(300).optional(),
  /** Re-fetch every pinned bug instead of adding one. */
  refreshAll: z.boolean().optional(),
});

export async function POST(request: Request) {
  return handle('watchlist.add', async () => {
    const parsed = await parseBody(request, addSchema);
    if (!parsed.ok) return parsed.response;

    await bootstrap();

    try {
      const result = await addToWatchlist(parsed.data.workItemId, parsed.data.note);
      return ok(result);
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) {
        return fail('NOT_FOUND', error.message, 404, {
          remedy: 'Check the work item number, and that the PAT can read work items.',
        });
      }
      throw error;
    }
  });
}

const deleteSchema = z.object({
  workItemId: z.coerce.number().int().positive(),
});

/** Unpins a bug. Cached pull requests are kept, so nothing is lost. */
export async function DELETE(request: Request) {
  return handle('watchlist.remove', async () => {
    const parsed = parseQuery(request, deleteSchema);
    if (!parsed.ok) return parsed.response;

    await bootstrap();
    const removed = await removeFromWatchlist(parsed.data.workItemId);

    if (!removed) {
      return fail('NOT_FOUND', `Work item ${parsed.data.workItemId} is not on the watchlist.`, 404);
    }
    return ok({ removed: true, workItemId: parsed.data.workItemId });
  });
}

/** PATCH re-fetches every pinned bug. */
export async function PATCH() {
  return handle('watchlist.refresh', async () => {
    await bootstrap();
    const results = await refreshWatchlist();
    return ok({
      refreshed: results.length,
      pullRequests: results.reduce((total, result) => total + result.cached, 0),
      results,
    });
  });
}
