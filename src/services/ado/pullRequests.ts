import { z } from 'zod';

import type { AdoClient } from '@/services/ado/client';
import {
  adoCommitRefSchema,
  adoCreatedPullRequestSchema,
  adoListSchema,
  adoPullRequestSchema,
  adoWorkItemRefSchema,
} from '@/types/ado/schemas';
import type {
  AdoCommitRef,
  AdoCreatedPullRequest,
  AdoPullRequest,
} from '@/types/ado/schemas';

/**
 * Pull request reads and PR creation.
 *
 * One API detail is load-bearing and easy to get wrong: the value of
 * `searchCriteria.targetRefName` must keep its slashes unescaped. Azure DevOps
 * answers 200 to a percent-encoded ref but silently drops the filter and
 * returns every completed PR in the repository. The client's query encoder
 * handles this; do not hand-encode ref names before passing them in.
 */

const PAGE_SIZE = 100;

export type PullRequestStatus = 'active' | 'completed' | 'abandoned' | 'all';

export interface ListPullRequestsOptions {
  repositoryId: string;
  status?: PullRequestStatus;
  /** Branch name with or without refs/heads/. */
  targetBranch?: string;
  sourceBranch?: string;
  /** Safety valve so an unexpectedly huge branch cannot spin forever. */
  maxPages?: number;
}

function toRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

/** Pages through the PR list until ADO returns a short page. */
export async function listPullRequests(
  client: AdoClient,
  options: ListPullRequestsOptions,
): Promise<AdoPullRequest[]> {
  const { repositoryId, status = 'completed', targetBranch, sourceBranch } = options;
  const maxPages = options.maxPages ?? 40;

  const collected: AdoPullRequest[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const result = await client.get(
      `_apis/git/repositories/${repositoryId}/pullrequests`,
      adoListSchema(adoPullRequestSchema),
      {
        query: {
          'searchCriteria.status': status,
          'searchCriteria.targetRefName': targetBranch ? toRef(targetBranch) : undefined,
          'searchCriteria.sourceRefName': sourceBranch ? toRef(sourceBranch) : undefined,
          $top: PAGE_SIZE,
          $skip: page * PAGE_SIZE,
        },
      },
    );

    collected.push(...result.value);
    if (result.value.length < PAGE_SIZE) break;
  }

  return collected;
}

export async function getPullRequest(
  client: AdoClient,
  repositoryId: string,
  pullRequestId: number,
): Promise<AdoPullRequest> {
  return client.get(
    `_apis/git/repositories/${repositoryId}/pullrequests/${pullRequestId}`,
    adoPullRequestSchema,
  );
}

/**
 * Commits on the PR's source branch.
 *
 * Note these are *not* necessarily the commits that landed on the target
 * branch. For a squash-merged PR nothing here exists on the release branch.
 * The cherry-pick planner uses lastMergeCommit instead; this is for display
 * and for the rebase-strategy case.
 */
export async function getPullRequestCommits(
  client: AdoClient,
  repositoryId: string,
  pullRequestId: number,
): Promise<AdoCommitRef[]> {
  const result = await client.get(
    `_apis/git/repositories/${repositoryId}/pullrequests/${pullRequestId}/commits`,
    adoListSchema(adoCommitRefSchema),
  );
  // ADO returns newest first; the planner and logs want oldest first.
  return [...result.value].reverse();
}

export async function getPullRequestWorkItemIds(
  client: AdoClient,
  repositoryId: string,
  pullRequestId: number,
): Promise<number[]> {
  const result = await client.get(
    `_apis/git/repositories/${repositoryId}/pullrequests/${pullRequestId}/workitems`,
    adoListSchema(adoWorkItemRefSchema),
  );
  return result.value.map((item) => item.id);
}

/**
 * Fetches a commit so its parent count can be read. The parent count decides
 * whether cherry-pick needs `-m 1`, and the PR payload does not reliably
 * include parents on `lastMergeCommit`.
 */
export async function getCommit(
  client: AdoClient,
  repositoryId: string,
  commitSha: string,
): Promise<AdoCommitRef> {
  return client.get(
    `_apis/git/repositories/${repositoryId}/commits/${commitSha}`,
    adoCommitRefSchema,
  );
}

export interface CreatePullRequestInput {
  repositoryId: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  /** Reviewer identity ids. Groups are allowed but do not satisfy the
   *  "minimum reviewers" policy, which ignores the creator's own vote. */
  reviewerIds?: readonly string[];
  workItemIds?: readonly number[];
  isDraft?: boolean;
  /**
   * Merge strategy recorded for completion. Setting it does not complete the
   * pull request; it pre-selects how a human's completion will merge.
   */
  squashMerge?: boolean;
}

/**
 * Creates a pull request. Never sets autoComplete: target branches carry
 * blocking build and review policies, and the brief forbids auto-merging.
 */
export async function createPullRequest(
  client: AdoClient,
  input: CreatePullRequestInput,
): Promise<AdoCreatedPullRequest> {
  const payload: Record<string, unknown> = {
    sourceRefName: toRef(input.sourceBranch),
    targetRefName: toRef(input.targetBranch),
    title: input.title,
    description: input.description,
    isDraft: input.isDraft ?? false,
  };

  if (input.reviewerIds?.length) {
    payload.reviewers = input.reviewerIds.map((id) => ({ id }));
  }

  if (input.workItemIds?.length) {
    // Target branches have a blocking "work item linking" policy, so a PR
    // created without one could never complete.
    payload.workItemRefs = input.workItemIds.map((id) => ({ id: String(id) }));
  }

  // `completionOptions` is deliberately not sent here. Azure DevOps accepts it
  // on create and silently discards it - verified on PRs 387436 and 387437,
  // which came back with empty completionOptions. It has to be applied with a
  // follow-up PATCH instead; see setMergeStrategy.

  return client.post(
    `_apis/git/repositories/${input.repositoryId}/pullrequests`,
    payload,
    adoCreatedPullRequestSchema,
  );
}

/**
 * Records the merge strategy a human's completion should use.
 *
 * Must be a separate call: Azure DevOps ignores completionOptions supplied at
 * creation time. This does not complete or auto-complete the pull request -
 * `autoCompleteSetBy` is never sent - it only pre-selects squash so the
 * release branch gets one commit per fix.
 */
export async function setMergeStrategy(
  client: AdoClient,
  repositoryId: string,
  pullRequestId: number,
  squashMerge: boolean,
): Promise<boolean> {
  const schema = z.object({
    completionOptions: z
      .object({ squashMerge: z.boolean().nullish(), mergeStrategy: z.string().nullish() })
      .nullish(),
  });

  const updated = await client.patch(
    `_apis/git/repositories/${repositoryId}/pullrequests/${pullRequestId}`,
    {
      completionOptions: {
        squashMerge,
        mergeStrategy: squashMerge ? 'squash' : 'noFastForward',
      },
    },
    schema,
  );

  return updated.completionOptions?.squashMerge === squashMerge;
}

/** Web URL for a PR, which the REST `url` field does not provide. */
export function pullRequestWebUrl(
  orgUrl: string,
  project: string,
  repositoryName: string,
  pullRequestId: number,
): string {
  return `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(
    repositoryName,
  )}/pullrequest/${pullRequestId}`;
}
