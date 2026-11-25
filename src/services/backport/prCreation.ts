import { createLogger } from '@/lib/logging/logger';
import type { AdoClient } from '@/services/ado/client';
import {
  createPullRequest,
  pullRequestWebUrl,
  setMergeStrategy,
} from '@/services/ado/pullRequests';
import type { AdoPullRequest } from '@/types/ado/schemas';

const log = createLogger('pr-creation');

/**
 * Creating the backport pull request.
 *
 * The target branches in this project carry eleven blocking policies, two of
 * which decide whether a created pull request is usable at all:
 *
 *  - "Work item linking" is blocking, so a PR with no linked work item can
 *    never complete. The work item id is taken from the `hotfix/{id}-{slug}`
 *    branch convention and from the original PR's own links.
 *  - "Minimum number of reviewers" is 1 with creatorVoteCounts = false, so an
 *    individual other than the creator must approve. The policy's required
 *    reviewer is a group that ADO attaches automatically, which does *not*
 *    satisfy this, so individual reviewers are copied from the original PR.
 *
 * Auto-complete is never set. A created PR waiting on builds and review is the
 * expected successful outcome, not a stalled one.
 */

export interface TemplateVars {
  prId: number;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  targetVersion: string;
  originalTitle: string;
  pickSha: string;
}

/** Substitutes {placeholder} tokens. Unknown placeholders are left untouched. */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const lookup: Record<string, string | number> = { ...vars };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = lookup[key];
    return value === undefined ? match : String(value);
  });
}

/** `release/26.5.1.PRE` -> `26.5.1.PRE`, used in titles. */
export function versionLabelFor(targetBranch: string): string {
  return targetBranch.replace(/^refs\/heads\//, '').replace(/^release\//, '');
}

/**
 * Individual reviewers worth copying.
 *
 * Groups are excluded because ADO adds policy-required groups itself and a
 * group vote does not satisfy the minimum-reviewer policy. The original author
 * is excluded as well: on a backport they are usually the creator, whose own
 * vote does not count.
 */
export function reviewersToCopy(
  original: AdoPullRequest,
  options: { excludeIdentityIds?: readonly string[] } = {},
): string[] {
  const excluded = new Set(options.excludeIdentityIds ?? []);
  excluded.add(original.createdBy.id);

  return original.reviewers
    .filter((reviewer) => !reviewer.isContainer)
    .filter((reviewer) => !excluded.has(reviewer.id))
    .map((reviewer) => reviewer.id);
}

export interface CreateBackportPrInput {
  client: AdoClient;
  orgUrl: string;
  project: string;
  repositoryName: string;
  adoRepositoryId: string;
  original: AdoPullRequest;
  backportBranch: string;
  targetBranch: string;
  pickSha: string;
  workItemIds: readonly number[];
  templates: {
    title: string;
    description: string;
  };
  reviewers: {
    copyFromOriginal: boolean;
    fixedIds: readonly string[];
  };
  isDraft: boolean;
  /** Merge strategy recorded for completion; does not complete the PR. */
  squashMerge: boolean;
  /** Identity of the tool itself, excluded from copied reviewers. */
  currentUserId?: string | null;
}

export interface CreatedBackportPr {
  pullRequestId: number;
  url: string;
  title: string;
  reviewerIds: string[];
  workItemIds: number[];
  warnings: string[];
}

export async function createBackportPullRequest(
  input: CreateBackportPrInput,
): Promise<CreatedBackportPr> {
  const warnings: string[] = [];

  const vars: TemplateVars = {
    prId: input.original.pullRequestId,
    repo: input.repositoryName,
    sourceBranch: input.original.targetRefName.replace(/^refs\/heads\//, ''),
    targetBranch: input.targetBranch,
    targetVersion: versionLabelFor(input.targetBranch),
    originalTitle: stripExistingVersionTag(input.original.title),
    pickSha: input.pickSha,
  };

  const title = renderTemplate(input.templates.title, vars).slice(0, 400);
  const description = renderTemplate(input.templates.description, vars);

  const reviewerIds = new Set<string>(input.reviewers.fixedIds);
  if (input.reviewers.copyFromOriginal) {
    for (const id of reviewersToCopy(input.original, {
      excludeIdentityIds: input.currentUserId ? [input.currentUserId] : [],
    })) {
      reviewerIds.add(id);
    }
  }

  if (reviewerIds.size === 0) {
    warnings.push(
      'No individual reviewer could be determined. The target branch requires one ' +
      'non-creator approval, so add a reviewer manually or this PR cannot complete.',
    );
  }

  if (input.workItemIds.length === 0) {
    warnings.push(
      'No work item is linked. "Work item linking" is a blocking policy on this ' +
      'branch, so the PR cannot complete until one is attached.',
    );
  }

  const created = await createPullRequest(input.client, {
    repositoryId: input.adoRepositoryId,
    sourceBranch: input.backportBranch,
    targetBranch: input.targetBranch,
    title,
    description,
    reviewerIds: [...reviewerIds],
    workItemIds: input.workItemIds,
    isDraft: input.isDraft,
    squashMerge: input.squashMerge,
  });

  // A separate call, because ADO discards completionOptions sent at creation.
  // Non-fatal: the pull request is already usable, the strategy is just not
  // pre-selected, and "Require a merge strategy" is a blocking policy that
  // would prompt whoever completes it.
  try {
    const applied = await setMergeStrategy(
      input.client,
      input.adoRepositoryId,
      created.pullRequestId,
      input.squashMerge,
    );
    if (!applied) {
      warnings.push('Azure DevOps did not record the squash merge strategy on this pull request.');
    }
  } catch (error) {
    warnings.push(`Could not set the merge strategy: ${(error as Error).message}`);
  }

  const url = pullRequestWebUrl(
    input.orgUrl,
    input.project,
    input.repositoryName,
    created.pullRequestId,
  );

  log.info('created backport pull request', {
    pullRequestId: created.pullRequestId,
    repository: input.repositoryName,
    targetBranch: input.targetBranch,
    reviewers: reviewerIds.size,
    workItems: input.workItemIds.length,
    warnings: warnings.length,
  });

  return {
    pullRequestId: created.pullRequestId,
    url,
    title,
    reviewerIds: [...reviewerIds],
    workItemIds: [...input.workItemIds],
    warnings,
  };
}

/**
 * Removes any leading `… | <version> |` tag from the original title.
 *
 * This project embeds the release in titles, and the prefix is not a fixed
 * shape. Both of these occur in real pull requests:
 *
 *   core-application | 26.2.1.PRE | optimized ef query
 *   Cherry-Pick | packout | 26.2.1.PRE | Fix phantom parent resolution
 *
 * The first version taken from this code handled only the first form, so a
 * backport of the second produced the doubled title
 * `packout | 26.2.1.0 | Cherry-Pick | packout | 26.2.1.PRE | …`.
 *
 * So: find the first segment within the leading few that looks like a version
 * and keep everything after it. The search is bounded to the first three
 * segments so a version-like string inside the description is not mistaken for
 * a prefix, and a title with no version tag is returned untouched.
 */
const VERSION_SEGMENT = /^\s*v?\d+\.\d+/;
const MAX_PREFIX_SEGMENTS = 3;

export function stripExistingVersionTag(title: string): string {
  const parts = title.split('|');
  if (parts.length < 3) return title.trim();

  const limit = Math.min(MAX_PREFIX_SEGMENTS, parts.length - 1);
  for (let index = 0; index < limit; index += 1) {
    if (VERSION_SEGMENT.test(parts[index])) {
      return parts
        .slice(index + 1)
        .join('|')
        .trim();
    }
  }

  return title.trim();
}
