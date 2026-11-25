import { z } from 'zod';

/**
 * Settings validation.
 *
 * Secrets are absent on purpose. The ADO organisation, project and PAT come
 * from server environment variables and are shown read-only in the UI: moving
 * the PAT into the database would put it somewhere a future API response could
 * leak it.
 */

export const settingsUpdateSchema = z
  .object({
    gitExecutable: z.string().min(1).max(500),
    mirrorDir: z.string().min(1).max(500),
    worktreeDir: z.string().min(1).max(500),

    committerName: z.string().min(1).max(200),
    committerEmail: z.email('Must be a valid email address'),

    backportBranchTemplate: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.includes('{workItemId}') || value.includes('{prId}'), {
        message:
          'Must include {workItemId} or {prId}, otherwise branches for different fixes collide',
      })
      .refine((value) => value.includes('{targetSlug}') || value.includes('{targetBranch}'), {
        message:
          'Must include {targetSlug} or {targetBranch}, otherwise backporting one fix to ' +
          'several releases reuses a single branch name and collides with the original fix branch',
      })
      .refine((value) => value.startsWith('hotfix/') || value.startsWith('backport/'), {
        message: 'Must start with "hotfix/" or "backport/" so the push guard allows it',
      }),
    prTitleTemplate: z.string().min(1).max(400),
    prDescriptionTemplate: z.string().min(1).max(4000),

    copyReviewersFromOriginal: z.boolean(),
    fixedReviewerIds: z.array(z.string().min(1)).max(20),
    createPrAsDraft: z.boolean(),

    concurrency: z.number().int().min(1).max(16),

    defaultOnlyMine: z.boolean(),
    closedWorkItemStates: z.array(z.string().min(1)).max(50),
    excludedWorkItemStates: z.array(z.string().min(1)).max(50),

    /** Repository names to track. */
    enabledRepositories: z.array(z.string().min(1)).max(500),
    /** Release branch names to show as columns. */
    enabledReleaseBranches: z.array(z.string().min(1)).max(100),
  })
  .partial();

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export const releaseBranchCreateSchema = z.object({
  branchName: z
    .string()
    .min(1)
    .max(300)
    .refine((value) => !value.startsWith('refs/'), {
      message: 'Give the branch name without the refs/heads/ prefix',
    }),
  versionLabel: z.string().min(1).max(40),
  stageLabel: z.string().min(1).max(40),
  sortOrder: z.number().int().min(0).max(1000),
});

export type ReleaseBranchCreate = z.infer<typeof releaseBranchCreateSchema>;
