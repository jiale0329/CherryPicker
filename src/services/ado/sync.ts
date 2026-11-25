import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/prisma/client';
import { AdoClient } from '@/services/ado/client';
import { listPullRequests } from '@/services/ado/pullRequests';
import { getBranchIndex } from '@/services/ado/repositories';
import { syncBackportPullRequests } from '@/services/ado/backportPrSync';
import { syncWorkItems } from '@/services/ado/workItems';
import { isIndividualApproval, parseWorkItemKey } from '@/services/backport/correlation';
import type { AdoPullRequest } from '@/types/ado/schemas';

const log = createLogger('ado-sync');

/**
 * Mirrors completed pull requests from ADO into CachedPullRequest.
 *
 * ADO stays authoritative; this cache exists so rendering the matrix does not
 * re-read ~850 pull requests per page view. `syncedAt` drives the staleness
 * indicator and the Refresh action re-reads from ADO.
 *
 * Commit parent counts are deliberately *not* fetched here. Reading them would
 * add one API call per pull request, and they are only needed when a backport
 * is actually planned, so the planner fetches them on demand.
 */

export interface SyncResult {
  repositoryName: string;
  branchesSynced: number;
  branchesMissing: string[];
  pullRequests: number;
  workItems: number;
  errors: { branch: string; message: string }[];
}

function mergeStrategyOf(pr: AdoPullRequest): string | null {
  if (pr.completionOptions?.squashMerge) return 'squash';
  return pr.completionOptions?.mergeStrategy ?? null;
}

export async function syncRepository(repositoryName: string): Promise<SyncResult> {
  const client = AdoClient.fromEnv();

  const repo = await prisma.trackedRepository.findUnique({ where: { name: repositoryName } });
  if (!repo) throw new Error(`Repository ${repositoryName} is not tracked.`);

  const releaseBranches = await prisma.releaseBranchConfig.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: 'asc' },
  });

  const branchIndex = await getBranchIndex(client, repo.adoRepositoryId);

  const result: SyncResult = {
    repositoryName,
    branchesSynced: 0,
    branchesMissing: [],
    pullRequests: 0,
    workItems: 0,
    errors: [],
  };

  const workItemIds = new Set<number>();

  for (const branch of releaseBranches) {
    if (!branchIndex.names.has(branch.branchName)) {
      // Expected: coverage is ragged across repositories.
      result.branchesMissing.push(branch.branchName);
      continue;
    }

    try {
      const prs = await listPullRequests(client, {
        repositoryId: repo.adoRepositoryId,
        status: 'completed',
        targetBranch: branch.branchName,
      });

      for (const pr of prs) {
        const sourceBranch = pr.sourceRefName.replace(/^refs\/heads\//, '');
        const targetBranch = pr.targetRefName.replace(/^refs\/heads\//, '');

        const key = parseWorkItemKey(sourceBranch);
        if (key) workItemIds.add(Number(key));

        await prisma.cachedPullRequest.upsert({
          where: {
            adoRepositoryId_pullRequestId: {
              adoRepositoryId: repo.adoRepositoryId,
              pullRequestId: pr.pullRequestId,
            },
          },
          create: {
            adoRepositoryId: repo.adoRepositoryId,
            pullRequestId: pr.pullRequestId,
            repositoryName: repo.name,
            title: pr.title,
            author: pr.createdBy.displayName,
            authorId: pr.createdBy.id,
            sourceBranch,
            targetBranch,
            status: pr.status,
            mergeStrategy: mergeStrategyOf(pr),
            lastMergeCommitSha: pr.lastMergeCommit?.commitId ?? null,
            correlationKey: parseWorkItemKey(sourceBranch),
            reviewersJson: JSON.stringify(
              pr.reviewers.map((reviewer) => ({
                id: reviewer.id,
                displayName: reviewer.displayName,
                vote: reviewer.vote,
                isContainer: reviewer.isContainer ?? false,
                counts: isIndividualApproval(reviewer),
              })),
            ),
            openedAt: new Date(pr.creationDate),
            closedAt: pr.closedDate ? new Date(pr.closedDate) : null,
          },
          update: {
            title: pr.title,
            status: pr.status,
            mergeStrategy: mergeStrategyOf(pr),
            lastMergeCommitSha: pr.lastMergeCommit?.commitId ?? null,
            correlationKey: parseWorkItemKey(sourceBranch),
            reviewersJson: JSON.stringify(
              pr.reviewers.map((reviewer) => ({
                id: reviewer.id,
                displayName: reviewer.displayName,
                vote: reviewer.vote,
                isContainer: reviewer.isContainer ?? false,
                counts: isIndividualApproval(reviewer),
              })),
            ),
            closedAt: pr.closedDate ? new Date(pr.closedDate) : null,
            syncedAt: new Date(),
          },
        });
      }

      await prisma.syncState.upsert({
        where: {
          adoRepositoryId_targetBranch: {
            adoRepositoryId: repo.adoRepositoryId,
            targetBranch: branch.branchName,
          },
        },
        create: {
          adoRepositoryId: repo.adoRepositoryId,
          targetBranch: branch.branchName,
          lastSyncedAt: new Date(),
          prCount: prs.length,
        },
        update: { lastSyncedAt: new Date(), prCount: prs.length, lastError: null },
      });

      result.branchesSynced += 1;

      result.pullRequests += prs.length;
      log.info('synced branch', {
        repository: repo.name,
        branch: branch.branchName,
        pullRequests: prs.length,
      });
    } catch (error) {
      const message = (error as Error).message;
      result.errors.push({ branch: branch.branchName, message });
      log.error('branch sync failed', { repository: repo.name, branch: branch.branchName, message });

      await prisma.syncState.upsert({
        where: {
          adoRepositoryId_targetBranch: {
            adoRepositoryId: repo.adoRepositoryId,
            targetBranch: branch.branchName,
          },
        },
        create: {
          adoRepositoryId: repo.adoRepositoryId,
          targetBranch: branch.branchName,
          lastError: message,
        },
        update: { lastError: message },
      });
    }
  }

  // Work item state drives the dashboard's state filter. Batched separately
  // because many pull requests share one work item, so this costs a handful of
  // calls rather than one per PR.
  if (workItemIds.size > 0) {
    try {
      result.workItems = await syncWorkItems(client, [...workItemIds]);
    } catch (error) {
      const message = (error as Error).message;
      result.errors.push({ branch: '(work items)', message });
      log.error('work item sync failed', { repository: repo.name, message });
    }
  }

  return result;
}

/** Branch names that exist in a repository, used by the matrix for inert cells. */
export async function getExistingReleaseBranches(repositoryName: string): Promise<Set<string>> {
  const repo = await prisma.trackedRepository.findUnique({ where: { name: repositoryName } });
  if (!repo) return new Set();

  const index = await getBranchIndex(AdoClient.fromEnv(), repo.adoRepositoryId);
  return new Set(index.names);
}

/**
 * Branch existence for every tracked repository, keyed by ADO repository id.
 *
 * Read live from ADO rather than from the cache so a newly cut release branch
 * appears without waiting for a full sync. Coverage is genuinely ragged:
 * core-sqldatabase has no 26.8 branches and core-consolidated-database has no
 * `.0` branches for 26.2 or 26.5.
 */
export async function getExistingBranchesByRepository(): Promise<Map<string, Set<string>>> {
  const client = AdoClient.fromEnv();
  const repos = await prisma.trackedRepository.findMany({ where: { enabled: true } });

  const entries = await Promise.all(
    repos.map(async (repo) => {
      try {
        const index = await getBranchIndex(client, repo.adoRepositoryId);
        return [repo.adoRepositoryId, new Set(index.names)] as const;
      } catch (error) {
        log.warn('could not list branches; treating all as absent', {
          repository: repo.name,
          error: (error as Error).message,
        });
        return [repo.adoRepositoryId, new Set<string>()] as const;
      }
    }),
  );

  return new Map(entries);
}

/** Syncs every tracked repository. */
export async function syncAllRepositories(): Promise<SyncResult[]> {
  const repos = await prisma.trackedRepository.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: 'asc' },
  });

  // ADO is authoritative for the pull requests this tool created, including
  // ones since abandoned or merged.
  await syncBackportPullRequests().catch((error) => {
    log.warn('could not refresh created pull requests', { error: (error as Error).message });
    return null;
  });

  const results: SyncResult[] = [];
  // Sequential on purpose: ADO throttles, and this is a handful of repositories.
  for (const repo of repos) {
    try {
      results.push(await syncRepository(repo.name));
    } catch (error) {
      results.push({
        repositoryName: repo.name,
        branchesSynced: 0,
        branchesMissing: [],
        pullRequests: 0,
        workItems: 0,
        errors: [{ branch: '(repository)', message: (error as Error).message }],
      });
    }
  }
  return results;
}
