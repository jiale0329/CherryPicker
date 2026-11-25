import { z } from 'zod';

import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/prisma/client';
import type { AdoClient } from '@/services/ado/client';
import { getPullRequest } from '@/services/ado/pullRequests';
import { isIndividualApproval, parseWorkItemKey } from '@/services/backport/correlation';

const log = createLogger('workitem-prs');

/**
 * Work-item-first fetch: ask ADO which pull requests belong to a bug.
 *
 * Better than the branch-scoped sync in two measurable ways, verified on work
 * item 1444759:
 *
 *  - It is authoritative rather than inferred. The branch-scoped path
 *    correlates by parsing `hotfix/{id}-{slug}`, and 5 of 853 pull requests
 *    used `feature/` instead and would be missed entirely.
 *  - It sees the whole picture. 1444759 links 17 pull requests across 3
 *    repositories and 8 branches; only 10 of those target the 6 configured
 *    releases, so the branch-scoped sync cannot see the rest.
 *
 * It is not a replacement, because it only answers questions about bugs you
 * already know the number of.
 */

const relationSchema = z.object({
  rel: z.string(),
  url: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const workItemWithRelationsSchema = z.object({
  id: z.number(),
  fields: z
    .object({
      'System.State': z.string().optional(),
      'System.WorkItemType': z.string().optional(),
      'System.Title': z.string().optional(),
      'System.AssignedTo': z.object({ displayName: z.string().optional() }).optional(),
    })
    .optional(),
  relations: z.array(relationSchema).nullish(),
});

export interface WorkItemPrLink {
  projectId: string;
  repositoryId: string;
  pullRequestId: number;
}

/**
 * Parses a pull request artifact link.
 *
 * Shape is `vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{prId}`, so the
 * payload must be URL-decoded before splitting.
 */
export function parsePullRequestArtifactLink(url: string): WorkItemPrLink | null {
  const marker = 'PullRequestId/';
  const index = url.indexOf(marker);
  if (index === -1) return null;

  const parts = decodeURIComponent(url.slice(index + marker.length)).split('/');
  if (parts.length < 3) return null;

  const pullRequestId = Number(parts[2]);
  if (!Number.isFinite(pullRequestId) || pullRequestId <= 0) return null;

  return { projectId: parts[0], repositoryId: parts[1], pullRequestId };
}

export interface WorkItemFetchResult {
  workItemId: number;
  title: string;
  state: string;
  workItemType: string;
  assignedTo?: string;
  /** Pull request links found on the work item. */
  linked: number;
  /** Of those, how many were cached (repository is tracked). */
  cached: number;
  /** Links in repositories this dashboard does not track. */
  skippedUntrackedRepos: number;
  repositories: string[];
  targetBranches: string[];
}

export class WorkItemNotFoundError extends Error {
  constructor(workItemId: number) {
    super(`Work item ${workItemId} does not exist, or the token cannot read it.`);
    this.name = 'WorkItemNotFoundError';
  }
}

/**
 * Fetches a bug and every pull request linked to it, caching what belongs to a
 * tracked repository.
 *
 * Pull requests in untracked repositories are counted and reported rather than
 * stored: a cached row for a repository the matrix never queries would be
 * invisible and misleading.
 */
export async function fetchWorkItemPullRequests(
  client: AdoClient,
  workItemId: number,
): Promise<WorkItemFetchResult> {
  const workItem = await client
    .get(`_apis/wit/workitems/${workItemId}`, workItemWithRelationsSchema, {
      query: { $expand: 'relations' },
    })
    .catch(() => null);

  if (!workItem) throw new WorkItemNotFoundError(workItemId);

  const fields = workItem.fields ?? {};
  const result: WorkItemFetchResult = {
    workItemId,
    title: fields['System.Title'] ?? '',
    state: fields['System.State'] ?? 'Unknown',
    workItemType: fields['System.WorkItemType'] ?? 'Unknown',
    assignedTo: fields['System.AssignedTo']?.displayName,
    linked: 0,
    cached: 0,
    skippedUntrackedRepos: 0,
    repositories: [],
    targetBranches: [],
  };

  await prisma.workItemCache.upsert({
    where: { id: workItemId },
    create: {
      id: workItemId,
      state: result.state,
      workItemType: result.workItemType,
      title: result.title,
      assignedTo: result.assignedTo ?? null,
    },
    update: {
      state: result.state,
      workItemType: result.workItemType,
      title: result.title,
      assignedTo: result.assignedTo ?? null,
      syncedAt: new Date(),
    },
  });

  const links = (workItem.relations ?? [])
    .filter((relation) => relation.rel === 'ArtifactLink')
    .map((relation) => parsePullRequestArtifactLink(relation.url))
    .filter((link): link is WorkItemPrLink => link !== null);

  result.linked = links.length;

  const tracked = await prisma.trackedRepository.findMany({
    where: { enabled: true },
    select: { name: true, adoRepositoryId: true },
  });
  const byId = new Map(tracked.map((repo) => [repo.adoRepositoryId.toLowerCase(), repo]));

  const repositories = new Set<string>();
  const branches = new Set<string>();

  for (const link of links) {
    const repo = byId.get(link.repositoryId.toLowerCase());
    if (!repo) {
      result.skippedUntrackedRepos += 1;
      continue;
    }

    const pr = await getPullRequest(client, repo.adoRepositoryId, link.pullRequestId).catch(
      () => null,
    );
    if (!pr) continue;

    const sourceBranch = pr.sourceRefName.replace(/^refs\/heads\//, '');
    const targetBranch = pr.targetRefName.replace(/^refs\/heads\//, '');

    const reviewers = JSON.stringify(
      pr.reviewers.map((reviewer) => ({
        id: reviewer.id,
        displayName: reviewer.displayName,
        vote: reviewer.vote,
        isContainer: reviewer.isContainer ?? false,
        counts: isIndividualApproval(reviewer),
      })),
    );

    // The work item is authoritative for correlation here, so fall back to it
    // when the branch name does not follow the hotfix convention.
    const correlationKey = parseWorkItemKey(sourceBranch) ?? String(workItemId);

    const common = {
      repositoryName: repo.name,
      title: pr.title,
      author: pr.createdBy.displayName,
      authorId: pr.createdBy.id,
      sourceBranch,
      targetBranch,
      status: pr.status,
      mergeStrategy: pr.completionOptions?.squashMerge
        ? 'squash'
        : (pr.completionOptions?.mergeStrategy ?? null),
      lastMergeCommitSha: pr.lastMergeCommit?.commitId ?? null,
      correlationKey,
      workItemIdsJson: JSON.stringify([workItemId]),
      reviewersJson: reviewers,
      closedAt: pr.closedDate ? new Date(pr.closedDate) : null,
    };

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
        openedAt: new Date(pr.creationDate),
        ...common,
      },
      update: { ...common, syncedAt: new Date() },
    });

    repositories.add(repo.name);
    branches.add(targetBranch);
    result.cached += 1;
  }

  result.repositories = [...repositories].sort();
  result.targetBranches = [...branches].sort();

  log.info('fetched work item pull requests', {
    workItemId,
    linked: result.linked,
    cached: result.cached,
    skippedUntrackedRepos: result.skippedUntrackedRepos,
  });

  return result;
}
