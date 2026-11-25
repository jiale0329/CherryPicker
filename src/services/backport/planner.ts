/**
 * Decides which commit to cherry-pick and how.
 *
 * This is the correctness core of the tool. The obvious implementation - read
 * `pullRequests/{id}/commits` and replay them - is wrong for this project.
 * Those are the *source branch* commits. When a PR is squash-merged they never
 * existed on the release branch; what landed was a single squashed commit.
 * Replaying the originals reapplies intermediate states ("fix", "address
 * review", "revert that") and both conflicts more often and can produce a
 * different tree than what shipped.
 *
 * Phase 0 measured 48 completed PRs across the four tracked repositories:
 *   40 squash, 8 noFastForward, and `lastMergeCommit` populated on all 48.
 * Source-branch commit counts ranged from 1 to 7.
 *
 * So the plan is built from `lastMergeCommit`, the commit that actually landed
 * on the target branch, and the parent count decides the command:
 *   1 parent  -> `git cherry-pick <sha>`
 *   2 parents -> `git cherry-pick -m 1 <sha>` (first parent is the branch being
 *                merged into, so -m 1 produces the diff the PR introduced)
 *
 * Verified against live data: on mms-wip-service, PR 384960's lastMergeCommit
 * f18d7b2e71 is the tip of release/26.2.1.0 and PR 384961's 6a0c681ef4 is the
 * tip of release/26.5.1.0.
 */

export type CherryPickMode = 'single' | 'mainline' | 'range';

export interface MergedPullRequestInput {
  pullRequestId: number;
  sourceRefName: string;
  targetRefName: string;
  /** `completionOptions.squashMerge`. Absent on PRs completed with the default. */
  squashMerge?: boolean | null;
  /** `completionOptions.mergeStrategy`: squash | noFastForward | rebase | rebaseMerge. */
  mergeStrategy?: string | null;
  lastMergeCommitSha?: string | null;
  /** Parent count of lastMergeCommit, read from the commit object. */
  lastMergeParentCount?: number | null;
  /** Commits on the source branch, oldest first. Used for rebase strategies. */
  sourceCommitShas?: readonly string[];
  lastMergeSourceCommitSha?: string | null;
  lastMergeTargetCommitSha?: string | null;
}

export interface CherryPickPlan {
  pullRequestId: number;
  sourceBranch: string;
  targetBranch: string;
  mode: CherryPickMode;
  /** Commits to apply, oldest first. One entry for single/mainline. */
  commitShas: readonly string[];
  /** Resolved strategy label, normalised. */
  mergeStrategy: NormalisedStrategy;
  /** Human-readable reason, surfaced in the execution log. */
  rationale: string;
  warnings: readonly string[];
}

export type PlanRefusalCode =
  | 'NO_MERGE_COMMIT'
  | 'UNKNOWN_PARENT_COUNT'
  | 'AMBIGUOUS_RANGE'
  | 'OCTOPUS_MERGE';

export interface PlanRefusal {
  code: PlanRefusalCode;
  message: string;
  /** What the developer can do instead. Shown in the detail panel. */
  remedy: string;
}

export type PlanResult =
  | { ok: true; plan: CherryPickPlan }
  | { ok: false; refusal: PlanRefusal };

export type NormalisedStrategy = 'squash' | 'noFastForward' | 'rebase' | 'rebaseMerge' | 'unknown';

export function normaliseStrategy(input: MergedPullRequestInput): NormalisedStrategy {
  if (input.squashMerge === true) return 'squash';

  switch ((input.mergeStrategy ?? '').toLowerCase()) {
    case 'squash':
      return 'squash';
    case 'nofastforward':
      return 'noFastForward';
    case 'rebase':
      return 'rebase';
    case 'rebasemerge':
      return 'rebaseMerge';
    default:
      return 'unknown';
  }
}

export function stripRefPrefix(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

export function planCherryPick(input: MergedPullRequestInput): PlanResult {
  const sourceBranch = stripRefPrefix(input.sourceRefName);
  const targetBranch = stripRefPrefix(input.targetRefName);
  const strategy = normaliseStrategy(input);
  const sha = input.lastMergeCommitSha?.trim();

  if (!sha) {
    return {
      ok: false,
      refusal: {
        code: 'NO_MERGE_COMMIT',
        message:
          `PR ${input.pullRequestId} has no lastMergeCommit, so the commit that ` +
          'landed on the release branch cannot be identified.',
        remedy:
          'Refresh the PR from Azure DevOps. If it is still missing, the PR was ' +
          'likely completed outside the normal flow and the backport must be done by hand.',
      },
    };
  }

  const parents = input.lastMergeParentCount;
  const warnings: string[] = [];

  // A rebase strategy replays each source commit onto the target, so the single
  // lastMergeCommit is only the final one. Picking it alone would silently drop
  // the earlier commits, which the brief forbids.
  if (strategy === 'rebase' || strategy === 'rebaseMerge') {
    const shas = input.sourceCommitShas ?? [];
    if (shas.length > 1) {
      return {
        ok: false,
        refusal: {
          code: 'AMBIGUOUS_RANGE',
          message:
            `PR ${input.pullRequestId} was completed with a ${strategy} strategy and ` +
            `carries ${shas.length} commits, so no single commit represents the change.`,
          remedy:
            'Cherry-pick the commit range manually, or re-run after confirming the ' +
            'exact commits that landed on the source branch.',
        },
      };
    }
    warnings.push(
      `Completed with ${strategy}; treating lastMergeCommit as the single replayed commit.`,
    );
    return {
      ok: true,
      plan: {
        pullRequestId: input.pullRequestId,
        sourceBranch,
        targetBranch,
        mode: 'single',
        commitShas: [sha],
        mergeStrategy: strategy,
        rationale: `${strategy} with a single commit: cherry-pick ${short(sha)}.`,
        warnings,
      },
    };
  }

  if (parents === null || parents === undefined) {
    return {
      ok: false,
      refusal: {
        code: 'UNKNOWN_PARENT_COUNT',
        message:
          `The parent count of ${short(sha)} is unknown, so it is not safe to ` +
          'choose between a plain cherry-pick and -m 1.',
        remedy: 'Refresh commit details for this pull request and retry.',
      },
    };
  }

  if (parents > 2) {
    return {
      ok: false,
      refusal: {
        code: 'OCTOPUS_MERGE',
        message: `${short(sha)} has ${parents} parents, which cherry-pick cannot replay.`,
        remedy: 'Backport this change manually.',
      },
    };
  }

  // Cross-check the declared strategy against the commit's actual shape and
  // trust the commit, because the shape is what cherry-pick has to deal with.
  if (strategy === 'squash' && parents === 2) {
    warnings.push(
      'PR is marked squash but lastMergeCommit has two parents; using -m 1 based on the commit.',
    );
  }
  if (strategy === 'noFastForward' && parents === 1) {
    warnings.push(
      'PR is marked noFastForward but lastMergeCommit has one parent; using a plain cherry-pick.',
    );
  }
  if (strategy === 'unknown') {
    warnings.push(
      'PR has no completionOptions; strategy inferred from the commit parent count.',
    );
  }

  const mode: CherryPickMode = parents === 2 ? 'mainline' : 'single';

  return {
    ok: true,
    plan: {
      pullRequestId: input.pullRequestId,
      sourceBranch,
      targetBranch,
      mode,
      commitShas: [sha],
      mergeStrategy: strategy,
      rationale:
        mode === 'mainline'
          ? `Merge commit ${short(sha)} has 2 parents: cherry-pick -m 1.`
          : `Single-parent commit ${short(sha)}: plain cherry-pick.`,
      warnings,
    },
  };
}

/** Git arguments for a plan. Returned as an array so nothing is shell-parsed. */
export function cherryPickArgs(plan: CherryPickPlan): string[] {
  const args = ['cherry-pick', '-x'];
  if (plan.mode === 'mainline') args.push('-m', '1');
  args.push(...plan.commitShas);
  return args;
}

function short(sha: string): string {
  return sha.slice(0, 10);
}
