import { z } from 'zod';

import type { AdoClient } from '@/services/ado/client';
import { adoListSchema, adoRefSchema, adoRepositorySchema } from '@/types/ado/schemas';
import type { AdoRef, AdoRepository } from '@/types/ado/schemas';

/**
 * Repository and branch reads.
 *
 * Branch coverage across the tracked repositories is ragged - core-sqldatabase
 * has no 26.8 branches, core-consolidated-database has no `.0` branches for
 * 26.2 or 26.5 - so the matrix has to resolve existence per repository instead
 * of assuming the configured release list applies everywhere.
 */

export async function listRepositories(client: AdoClient): Promise<AdoRepository[]> {
  const result = await client.get('_apis/git/repositories', adoListSchema(adoRepositorySchema));
  return result.value.filter((repo) => !repo.isDisabled);
}

export async function getRepository(
  client: AdoClient,
  nameOrId: string,
): Promise<AdoRepository> {
  return client.get(`_apis/git/repositories/${encodeURIComponent(nameOrId)}`, adoRepositorySchema);
}

/**
 * Lists refs under a prefix. `filter` is relative to `refs/`, so
 * `heads/release/` returns release branches only.
 */
export async function listRefs(
  client: AdoClient,
  repositoryId: string,
  filter = 'heads/',
): Promise<AdoRef[]> {
  const result = await client.get(
    `_apis/git/repositories/${repositoryId}/refs`,
    adoListSchema(adoRefSchema),
    { query: { filter, $top: 1000 } },
  );
  return result.value;
}

export interface BranchIndex {
  /** Branch names without the refs/heads/ prefix. */
  readonly names: ReadonlySet<string>;
  /** Branch name -> tip commit sha. */
  readonly tips: ReadonlyMap<string, string>;
}

export async function getBranchIndex(
  client: AdoClient,
  repositoryId: string,
  filter = 'heads/release/',
): Promise<BranchIndex> {
  const refs = await listRefs(client, repositoryId, filter);
  const names = new Set<string>();
  const tips = new Map<string, string>();

  for (const ref of refs) {
    const name = ref.name.replace(/^refs\/heads\//, '');
    names.add(name);
    tips.set(name, ref.objectId);
  }

  return { names, tips };
}

/** Resolves the authenticated identity, used to default the committer. */
export async function getAuthenticatedIdentity(
  client: AdoClient,
): Promise<{ id: string; displayName: string; email?: string }> {
  const schema = z.object({
    authenticatedUser: z.object({
      id: z.string(),
      providerDisplayName: z.string().default(''),
      properties: z
        .object({ Account: z.object({ $value: z.string() }).partial() })
        .partial()
        .optional(),
    }),
  });

  const data = await client.get('_apis/connectionData', schema, {
    projectScoped: false,
    apiVersion: '7.1-preview',
  });

  return {
    id: data.authenticatedUser.id,
    displayName: data.authenticatedUser.providerDisplayName,
    email: data.authenticatedUser.properties?.Account?.$value,
  };
}
