import { z } from 'zod';

/**
 * Zod schemas for the subset of Azure DevOps REST responses this app consumes.
 *
 * Every field the app relies on was verified against the real jblprd/jemsmm
 * project during the Phase 0 probe. Fields are deliberately permissive where
 * ADO omits them: `completionOptions` is absent entirely on PRs completed with
 * the default merge strategy, and `closedDate` is absent on active PRs.
 */

export const adoListSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    count: z.number().optional(),
    value: z.array(item).default([]),
  });

export const adoIdentitySchema = z.object({
  id: z.string(),
  displayName: z.string().default(''),
  uniqueName: z.string().optional(),
  descriptor: z.string().optional(),
});

export const adoRepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  defaultBranch: z.string().nullish(),
  size: z.number().nullish(),
  isDisabled: z.boolean().nullish(),
  webUrl: z.string().nullish(),
  project: z.object({ id: z.string(), name: z.string() }).optional(),
});

export const adoRefSchema = z.object({
  name: z.string(),
  objectId: z.string(),
});

export const adoCommitRefSchema = z.object({
  commitId: z.string(),
  comment: z.string().optional(),
  author: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
      date: z.string().optional(),
    })
    .optional(),
  parents: z.array(z.string()).optional(),
});

/**
 * Reviewers carry the vote that drives PR_APPROVED:
 *   10 approved, 5 approved with suggestions, 0 no vote,
 *   -5 waiting for author, -10 rejected.
 * `isContainer` marks a group. The blocking "minimum reviewers" policy on this
 * project does not count the creator, so group votes alone are not enough.
 */
export const adoReviewerSchema = adoIdentitySchema.extend({
  vote: z.number().default(0),
  isRequired: z.boolean().nullish(),
  isContainer: z.boolean().nullish(),
  hasDeclined: z.boolean().nullish(),
});

export const adoCompletionOptionsSchema = z.object({
  squashMerge: z.boolean().nullish(),
  mergeStrategy: z.string().nullish(),
  deleteSourceBranch: z.boolean().nullish(),
  bypassPolicy: z.boolean().nullish(),
});

export const adoPullRequestSchema = z.object({
  pullRequestId: z.number(),
  title: z.string().default(''),
  description: z.string().nullish(),
  status: z.string(),
  createdBy: adoIdentitySchema,
  creationDate: z.string(),
  closedDate: z.string().nullish(),
  sourceRefName: z.string(),
  targetRefName: z.string(),
  mergeStatus: z.string().nullish(),
  isDraft: z.boolean().nullish(),
  reviewers: z.array(adoReviewerSchema).default([]),
  completionOptions: adoCompletionOptionsSchema.nullish(),
  lastMergeCommit: adoCommitRefSchema.nullish(),
  lastMergeSourceCommit: adoCommitRefSchema.nullish(),
  lastMergeTargetCommit: adoCommitRefSchema.nullish(),
  repository: adoRepositorySchema.partial({ name: true }).optional(),
  url: z.string().optional(),
});

export const adoWorkItemRefSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  url: z.string().optional(),
});

export const adoCreatedPullRequestSchema = z.object({
  pullRequestId: z.number(),
  title: z.string().default(''),
  status: z.string(),
  sourceRefName: z.string(),
  targetRefName: z.string(),
  url: z.string().optional(),
  repository: z.object({ id: z.string(), name: z.string().optional() }).optional(),
});

export const adoConnectionDataSchema = z.object({
  authenticatedUser: z.object({
    id: z.string(),
    providerDisplayName: z.string().default(''),
    properties: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type AdoRepository = z.infer<typeof adoRepositorySchema>;
export type AdoRef = z.infer<typeof adoRefSchema>;
export type AdoPullRequest = z.infer<typeof adoPullRequestSchema>;
export type AdoCommitRef = z.infer<typeof adoCommitRefSchema>;
export type AdoReviewer = z.infer<typeof adoReviewerSchema>;
export type AdoWorkItemRef = z.infer<typeof adoWorkItemRefSchema>;
export type AdoCreatedPullRequest = z.infer<typeof adoCreatedPullRequestSchema>;
