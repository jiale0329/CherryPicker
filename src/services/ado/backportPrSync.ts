import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/prisma/client';
import { AdoClient } from '@/services/ado/client';
import { getPullRequest } from '@/services/ado/pullRequests';
import { isIndividualApproval, parseWorkItemKey } from '@/services/backport/correlation';

const log = createLogger('backport-pr-sync');

/**
 * Re-reads the pull requests this tool created, so their current state comes
 * from ADO rather than from what was true when the job finished.
 *
 * Without this, a stale job record masks reality. Observed on work item
 * 1444759: two created pull requests were abandoned, which also removed their
 * work item links, so no PR evidence remained and the matrix fell back to the
 * saved PR_CREATED status. The cells looked done while the backports were in
 * fact missing again - precisely the "previously saved status is still current"
 * assumption the brief rules out.
 *
 * Caching the pull request lets the existing status resolution handle it: an
 * abandoned target PR plus a job record resolves back to NOT_STARTED, so the
 * cell becomes actionable again.
 */

export interface BackportPrSyncResult {
  checked: number;
  updated: number;
  vanished: number;
}

export async function syncBackportPullRequests(): Promise<BackportPrSyncResult> {
  const jobs = await prisma.backportJob.findMany({
    where: { targetPrId: { not: null } },
    select: {
      id: true,
      adoRepositoryId: true,
      repositoryName: true,
      targetPrId: true,
      targetBranch: true,
    },
  });

  const result: BackportPrSyncResult = { checked: jobs.length, updated: 0, vanished: 0 };
  if (jobs.length === 0) return result;

  const client = AdoClient.fromEnv();

  for (const job of jobs) {
    if (job.targetPrId === null) continue;

    const pr = await getPullRequest(client, job.adoRepositoryId, job.targetPrId).catch(() => null);
    if (!pr) {
      // Deleted or no longer readable. Leave the job alone rather than guessing.
      result.vanished += 1;
      log.warn('created pull request could not be read', {
        repository: job.repositoryName,
        pullRequestId: job.targetPrId,
      });
      continue;
    }

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

    const common = {
      repositoryName: job.repositoryName,
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
      correlationKey: parseWorkItemKey(sourceBranch),
      reviewersJson: reviewers,
      closedAt: pr.closedDate ? new Date(pr.closedDate) : null,
    };

    await prisma.cachedPullRequest.upsert({
      where: {
        adoRepositoryId_pullRequestId: {
          adoRepositoryId: job.adoRepositoryId,
          pullRequestId: pr.pullRequestId,
        },
      },
      create: {
        adoRepositoryId: job.adoRepositoryId,
        pullRequestId: pr.pullRequestId,
        openedAt: new Date(pr.creationDate),
        ...common,
      },
      update: { ...common, syncedAt: new Date() },
    });

    result.updated += 1;
  }

  log.info('synced created pull requests', { ...result });
  return result;
}
