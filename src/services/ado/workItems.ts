import { z } from 'zod';

import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/prisma/client';
import type { AdoClient } from '@/services/ado/client';

const log = createLogger('ado-work-items');

/**
 * Work item state reads.
 *
 * States in this project are a custom set rather than the Agile defaults.
 * Measured across the cached fixes: Done, Fixed, Back Merged, Closed Rejected,
 * Confirmed Fixed, Ready to Test - all of type Bug. "Back Merged" is the team's
 * own marker for a propagated fix.
 *
 * `errorPolicy=omit` matters: without it, one deleted or inaccessible work item
 * fails the whole batch.
 */

const BATCH_SIZE = 200;

const workItemSchema = z.object({
  id: z.number(),
  fields: z
    .object({
      'System.State': z.string().optional(),
      'System.WorkItemType': z.string().optional(),
      'System.Title': z.string().optional(),
      'System.AssignedTo': z.object({ displayName: z.string().optional() }).optional(),
    })
    .optional(),
});

const workItemListSchema = z.object({
  count: z.number().optional(),
  value: z.array(workItemSchema).default([]),
});

export interface WorkItemSummary {
  id: number;
  state: string;
  workItemType: string;
  title: string;
  assignedTo?: string;
}

export async function getWorkItems(
  client: AdoClient,
  ids: readonly number[],
): Promise<WorkItemSummary[]> {
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
  if (unique.length === 0) return [];

  const collected: WorkItemSummary[] = [];

  for (let offset = 0; offset < unique.length; offset += BATCH_SIZE) {
    const batch = unique.slice(offset, offset + BATCH_SIZE);

    const result = await client.get('_apis/wit/workitems', workItemListSchema, {
      query: {
        ids: batch.join(','),
        fields: 'System.State,System.WorkItemType,System.Title,System.AssignedTo',
        // Tolerate ids that no longer resolve rather than failing the batch.
        errorPolicy: 'omit',
      },
    });

    for (const item of result.value) {
      if (!item.fields) continue;
      collected.push({
        id: item.id,
        state: item.fields['System.State'] ?? 'Unknown',
        workItemType: item.fields['System.WorkItemType'] ?? 'Unknown',
        title: item.fields['System.Title'] ?? '',
        assignedTo: item.fields['System.AssignedTo']?.displayName,
      });
    }
  }

  return collected;
}

/** Fetches and caches work item state for the given ids. */
export async function syncWorkItems(
  client: AdoClient,
  ids: readonly number[],
): Promise<number> {
  const items = await getWorkItems(client, ids);

  for (const item of items) {
    await prisma.workItemCache.upsert({
      where: { id: item.id },
      create: {
        id: item.id,
        state: item.state,
        workItemType: item.workItemType,
        title: item.title,
        assignedTo: item.assignedTo ?? null,
      },
      update: {
        state: item.state,
        workItemType: item.workItemType,
        title: item.title,
        assignedTo: item.assignedTo ?? null,
        syncedAt: new Date(),
      },
    });
  }

  log.info('synced work items', { requested: ids.length, resolved: items.length });
  return items.length;
}

/** Distinct states present in the cache, for the filter control. */
export async function getKnownWorkItemStates(): Promise<string[]> {
  const rows = await prisma.workItemCache.findMany({
    select: { state: true },
    distinct: ['state'],
    orderBy: { state: 'asc' },
  });
  return rows.map((row) => row.state);
}
