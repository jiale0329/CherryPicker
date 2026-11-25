import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getServerEnv } from '@/lib/config/env';
import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/prisma/client';
import { AdoClient } from '@/services/ado/client';
import {
  getCommit,
  getPullRequest,
  getPullRequestWorkItemIds,
} from '@/services/ado/pullRequests';
import { buildBackportBranchName, parseWorkItemKey } from '@/services/backport/correlation';
import {
  beginJob,
  appendLogs,
  completeJob,
  statusForOutcome,
} from '@/services/backport/jobStore';
import { createBackportPullRequest } from '@/services/backport/prCreation';
import { cherryPickArgs, planCherryPick, type CherryPickPlan } from '@/services/backport/planner';
import { checkForDuplicate, type DuplicateCheck } from '@/services/git/duplicate';
import { Git } from '@/services/git/gitExec';
import { ensureMirror, hasCommit, resolveBranch } from '@/services/git/mirror';
import { conflictedFiles, createWorktree } from '@/services/git/worktree';
import type { Evidence } from '@/services/backport/correlation';

const log = createLogger('backport-engine');

/**
 * Backport execution.
 *
 * Runs the workflow up to and including the cherry-pick, in an isolated
 * worktree, and reports what happened. `dryRun` controls whether anything
 * leaves the machine:
 *
 *   dryRun: true   fetch, plan, duplicate check, cherry-pick, report, clean up.
 *                  Nothing is pushed and no pull request is created.
 *   dryRun: false  additionally pushes the backport branch (Phase 4 adds the
 *                  pull request).
 *
 * Dry run is the default. The expensive and risky parts - resolving the right
 * commit, applying it, detecting conflicts - are identical either way, so a dry
 * run is a genuine rehearsal rather than a simulation.
 */

export type BackportOutcome =
  | 'DRY_RUN_CLEAN'
  | 'PUSHED'
  | 'PR_CREATED'
  | 'SKIPPED_ALREADY_PRESENT'
  | 'NEEDS_REVIEW'
  | 'CONFLICT'
  | 'PLAN_REFUSED'
  | 'FAILED';

export interface BackportStep {
  step: string;
  ok: boolean;
  detail: string;
  durationMs?: number;
}

export interface BackportReport {
  jobId: string;
  dryRun: boolean;
  repositoryName: string;
  originalPrId: number;
  sourceBranch: string;
  targetBranch: string;
  backportBranch: string | null;
  outcome: BackportOutcome;
  plan: CherryPickPlan | null;
  planRefusal: { code: string; message: string; remedy: string } | null;
  duplicate: DuplicateCheck | null;
  conflictFiles: string[];
  /** Files the cherry-pick would change, on a clean dry run. */
  changedFiles: string[];
  diffStat: string | null;
  steps: BackportStep[];
  workItemIds: number[];
  errorMessage: string | null;
  /** Set once the backport branch reaches the remote. */
  pushed: boolean;
  targetPrId: number | null;
  targetPrUrl: string | null;
  /** Non-fatal problems, e.g. a PR created with no individual reviewer. */
  warnings: string[];
  startedAt: string;
  finishedAt: string;
}

export interface RunBackportInput {
  repositoryName: string;
  originalPrId: number;
  targetBranch: string;
  dryRun?: boolean;
}

export async function runBackport(input: RunBackportInput): Promise<BackportReport> {
  const dryRun = input.dryRun !== false;
  const jobId = randomUUID();
  const startedAt = new Date();
  const steps: BackportStep[] = [];

  const env = getServerEnv();
  const config = await prisma.appConfig.findFirst();
  if (!config) throw new Error('Configuration has not been initialised.');

  const repo = await prisma.trackedRepository.findUnique({
    where: { name: input.repositoryName },
  });
  if (!repo) throw new Error(`Repository ${input.repositoryName} is not tracked.`);

  const git = new Git(config.gitExecutable || env.GIT_EXECUTABLE);
  const committer = { name: config.committerName, email: config.committerEmail };

  /*
   * Settings store these as possibly relative paths. Resolve once here so no
   * git invocation can resolve them a second time against its own cwd - that
   * bug produced `.repo-cache/.repo-cache/<repo>.git` and broke the first run.
   *
   * turbopackIgnore: the values come from the database, so the bundler cannot
   * know them statically and would otherwise trace the entire project into the
   * server output.
   */
  const mirrorDir = path.resolve(/* turbopackIgnore: true */ process.cwd(), config.mirrorDir);
  const worktreeDir = path.resolve(/* turbopackIgnore: true */ process.cwd(), config.worktreeDir);

  const report: BackportReport = {
    jobId,
    dryRun,
    repositoryName: repo.name,
    originalPrId: input.originalPrId,
    sourceBranch: '',
    targetBranch: input.targetBranch,
    backportBranch: null,
    outcome: 'FAILED',
    plan: null,
    planRefusal: null,
    duplicate: null,
    conflictFiles: [],
    changedFiles: [],
    diffStat: null,
    steps,
    workItemIds: [],
    errorMessage: null,
    pushed: false,
    targetPrId: null,
    targetPrUrl: null,
    warnings: [],
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
  };

  const identity = {
    adoRepositoryId: repo.adoRepositoryId,
    originalPrId: input.originalPrId,
    targetBranch: input.targetBranch,
  };

  const track = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
    const begin = Date.now();
    try {
      const value = await run();
      steps.push({ step, ok: true, detail: 'ok', durationMs: Date.now() - begin });
      return value;
    } catch (error) {
      steps.push({
        step,
        ok: false,
        detail: (error as Error).message,
        durationMs: Date.now() - begin,
      });
      throw error;
    }
  };

  let worktree: Awaited<ReturnType<typeof createWorktree>> | null = null;
  // Only persist a result if a job row was actually created; a failure while
  // still reading from ADO is not an execution worth recording.
  let persisted = false;

  try {
    // --- 1. the original pull request -------------------------------------
    const client = AdoClient.fromEnv();
    const pr = await track('fetch-pull-request', () =>
      getPullRequest(client, repo.adoRepositoryId, input.originalPrId),
    );

    report.sourceBranch = pr.sourceRefName.replace(/^refs\/heads\//, '');
    const workItemKey = parseWorkItemKey(report.sourceBranch);
    if (workItemKey) report.workItemIds = [Number(workItemKey)];

    const mergeSha = pr.lastMergeCommit?.commitId ?? null;

    // --- 2. the commit that actually landed -------------------------------
    // Parent count decides a plain cherry-pick versus -m 1, and the pull
    // request payload does not reliably include parents. One call per job,
    // which is why sync does not fetch this for all 1,050 pull requests.
    let parentCount: number | null = null;
    if (mergeSha) {
      const commit = await track('fetch-merge-commit', () =>
        getCommit(client, repo.adoRepositoryId, mergeSha),
      );
      parentCount = commit.parents?.length ?? null;
    }

    // --- 3. plan -----------------------------------------------------------
    const planResult = planCherryPick({
      pullRequestId: pr.pullRequestId,
      sourceRefName: pr.sourceRefName,
      targetRefName: `refs/heads/${input.targetBranch}`,
      squashMerge: pr.completionOptions?.squashMerge ?? null,
      mergeStrategy: pr.completionOptions?.mergeStrategy ?? null,
      lastMergeCommitSha: mergeSha,
      lastMergeParentCount: parentCount,
    });

    if (!planResult.ok) {
      report.planRefusal = planResult.refusal;
      report.outcome = 'PLAN_REFUSED';
      steps.push({
        step: 'plan',
        ok: false,
        detail: `${planResult.refusal.code}: ${planResult.refusal.message}`,
      });
      return finish(report, startedAt);
    }

    report.plan = planResult.plan;
    steps.push({ step: 'plan', ok: true, detail: planResult.plan.rationale });

    report.backportBranch = buildBackportBranchName(config.backportBranchTemplate, {
      prId: pr.pullRequestId,
      targetBranch: input.targetBranch,
      workItemId: workItemKey,
      title: pr.title,
    });

    /*
     * Only real executions are recorded.
     *
     * A dry run is a rehearsal: it pushes nothing and changes nothing remote,
     * so writing it to the job table would fill the history page with events
     * that never happened and leave rows whose status has to be explained.
     * The row is written before any git work so that a crash mid-cherry-pick
     * still leaves a trace, which reconcileInterruptedJobs clears on restart.
     */
    if (!dryRun) {
      await beginJob({
        jobId,
        ...identity,
        repositoryName: repo.name,
        originalPrTitle: pr.title,
        originalPrAuthor: pr.createdBy.displayName,
        sourceBranch: report.sourceBranch,
        mergeStrategy: planResult.plan.mergeStrategy,
        pickCommitSha: planResult.plan.commitShas[0],
        pickParentCount: parentCount ?? 1,
        workItemIds: report.workItemIds,
        correlationKey: workItemKey,
      });
      persisted = true;
    }

    // --- 4. mirror ---------------------------------------------------------
    const mirror = await track('ensure-mirror', () =>
      ensureMirror(
        {
          git,
          mirrorDir,
          pat: env.ADO_PAT,
          askPassPath: env.askPassPath,
          caBundlePath: env.caBundlePath,
        },
        {
          repositoryName: repo.name,
          orgUrl: config.adoOrgUrl,
          project: config.adoProject,
        },
      ),
    );

    // --- 5. validate branches ---------------------------------------------
    await track('validate-branches', async () => {
      const targetSha = await resolveBranch(git, mirror.mirrorPath, input.targetBranch);
      if (!targetSha) {
        throw new Error(
          `Target branch ${input.targetBranch} does not exist in ${repo.name}. ` +
          'Nothing to backport into.',
        );
      }
      /*
       * Never overwrite an existing branch.
       *
       * This matters more now the convention is `hotfix/...`, the same
       * namespace the original fix branches use. The mirror was fetched a
       * moment ago, so its refs reflect the remote.
       */
      const existingBackport = await resolveBranch(git, mirror.mirrorPath, report.backportBranch!);
      if (existingBackport) {
        throw new Error(
          `Branch ${report.backportBranch} already exists in ${repo.name} at ` +
          `${existingBackport.slice(0, 10)}. Refusing to overwrite it. Delete the branch, ` +
          'or adjust the branch template, if this is a retry of an abandoned attempt.',
        );
      }

      const present = await hasCommit(git, mirror.mirrorPath, planResult.plan.commitShas[0]);
      if (!present) {
        throw new Error(
          `Commit ${planResult.plan.commitShas[0].slice(0, 10)} is not in the local mirror ` +
          'even after fetching. The pull request may have been completed on a branch ' +
          'that has since been deleted.',
        );
      }
    });

    // --- 6. duplicate detection -------------------------------------------
    const duplicate = await track('duplicate-check', () =>
      checkForDuplicate({
        git,
        options: { cwd: mirror.mirrorPath, timeoutMs: 120_000 },
        commitSha: planResult.plan.commitShas[0],
        targetRef: `refs/heads/${input.targetBranch}`,
        workItemId: workItemKey,
      }),
    );
    report.duplicate = duplicate;

    if (duplicate.alreadyPresent) {
      report.outcome = 'SKIPPED_ALREADY_PRESENT';
      return finish(report, startedAt);
    }

    // --- 7. worktree + cherry-pick ----------------------------------------
    worktree = await track('create-worktree', () =>
      createWorktree({
        git,
        mirrorPath: mirror.mirrorPath,
        worktreeDir,
        branch: report.backportBranch!,
        startPoint: input.targetBranch,
        committer,
        jobId,
        // Needed by the push step; harmless for a dry run, which never pushes.
        pat: env.ADO_PAT,
        askPassPath: env.askPassPath,
        caBundlePath: env.caBundlePath,
      }),
    );

    const pick = await worktree.exec(cherryPickArgs(planResult.plan), { allowFailure: true });

    if (pick.exitCode !== 0) {
      report.conflictFiles = await conflictedFiles(worktree);
      report.outcome = 'CONFLICT';
      steps.push({
        step: 'cherry-pick',
        ok: false,
        detail:
          report.conflictFiles.length > 0
            ? `Conflicts in ${report.conflictFiles.length} file(s): ${report.conflictFiles.join(', ')}`
            : pick.stderr || pick.stdout,
      });

      // Abort so nothing is left half-applied, then discard the worktree.
      await worktree.exec(['cherry-pick', '--abort'], { allowFailure: true });
      return finish(report, startedAt);
    }

    steps.push({ step: 'cherry-pick', ok: true, detail: 'applied cleanly' });

    // --- 8. what the pick changed -----------------------------------------
    const changed = await worktree.exec(['diff', '--name-only', 'HEAD~1', 'HEAD'], {
      allowFailure: true,
    });
    report.changedFiles = changed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const stat = await worktree.exec(['diff', '--stat', 'HEAD~1', 'HEAD'], { allowFailure: true });
    report.diffStat = stat.stdout || null;

    if (dryRun) {
      report.outcome = duplicate.likelyPresent ? 'NEEDS_REVIEW' : 'DRY_RUN_CLEAN';
      steps.push({
        step: 'dry-run',
        ok: true,
        detail: 'Nothing pushed and no pull request created.',
      });
      return finish(report, startedAt);
    }

    // --- 9. push the backport branch --------------------------------------
    // The guards reject anything that is not a plain, non-forced push to a
    // branch under the backport prefix, so this cannot touch a release branch.
    await track('push', () =>
      worktree!.exec(['push', 'origin', `HEAD:refs/heads/${report.backportBranch}`]),
    );
    report.pushed = true;

    // --- 10. create the pull request --------------------------------------
    // Work items come from both the branch convention and the original PR's
    // own links, because "work item linking" is a blocking policy.
    const linkedWorkItems = new Set<number>(report.workItemIds);
    try {
      for (const id of await getPullRequestWorkItemIds(
        client,
        repo.adoRepositoryId,
        input.originalPrId,
      )) {
        linkedWorkItems.add(id);
      }
    } catch (error) {
      report.warnings.push(
        `Could not read the original pull request's work items: ${(error as Error).message}`,
      );
    }
    report.workItemIds = [...linkedWorkItems];

    const created = await track('create-pull-request', () =>
      createBackportPullRequest({
        client,
        orgUrl: config.adoOrgUrl,
        project: config.adoProject,
        repositoryName: repo.name,
        adoRepositoryId: repo.adoRepositoryId,
        original: pr,
        backportBranch: report.backportBranch!,
        targetBranch: input.targetBranch,
        pickSha: planResult.plan.commitShas[0],
        workItemIds: report.workItemIds,
        templates: {
          title: config.prTitleTemplate,
          description: config.prDescriptionTemplate,
        },
        reviewers: {
          copyFromOriginal: config.copyReviewersFromOriginal,
          fixedIds: parseJsonStringArray(config.fixedReviewerIdsJson),
        },
        isDraft: config.createPrAsDraft,
        squashMerge: config.prSquashMerge,
        currentUserId: config.adoUserId,
      }),
    );

    report.targetPrId = created.pullRequestId;
    report.targetPrUrl = created.url;
    report.warnings.push(...created.warnings);
    report.outcome = 'PR_CREATED';

    await prisma.pullRequestLink.upsert({
      where: {
        adoRepositoryId_originalPrId_targetPrId: {
          adoRepositoryId: repo.adoRepositoryId,
          originalPrId: input.originalPrId,
          targetPrId: created.pullRequestId,
        },
      },
      create: {
        adoRepositoryId: repo.adoRepositoryId,
        originalPrId: input.originalPrId,
        targetPrId: created.pullRequestId,
        targetBranch: input.targetBranch,
        discoverySource: 'job',
        confidence: 'definitive',
      },
      update: { targetBranch: input.targetBranch, discoverySource: 'job' },
    });

    return finish(report, startedAt);
  } catch (error) {
    report.errorMessage = (error as Error).message;
    report.outcome = report.outcome === 'FAILED' ? 'FAILED' : report.outcome;
    log.error('backport run failed', {
      jobId,
      repository: repo.name,
      originalPrId: input.originalPrId,
      targetBranch: input.targetBranch,
      error: report.errorMessage,
    });
    return finish(report, startedAt);
  } finally {
    // Always clean up, including on conflict: the worktree holds nothing that
    // is not reproducible by retrying.
    if (worktree) {
      try {
        await worktree.dispose();
      } catch (error) {
        log.warn('worktree cleanup failed', { jobId, error: (error as Error).message });
      }
    }

    if (persisted) {
      try {
        await appendLogs(identity, steps);
        await completeJob(identity, {
          status: statusForOutcome(report.outcome, report.pushed, report.targetPrId),
          backportBranch: report.backportBranch,
          targetPrId: report.targetPrId,
          targetPrUrl: report.targetPrUrl,
          conflictFiles: report.conflictFiles,
          errorCode: report.planRefusal?.code ?? (report.errorMessage ? 'RUN_FAILED' : null),
          errorMessage: report.errorMessage ?? report.planRefusal?.message ?? null,
        });
      } catch (error) {
        log.error('could not persist job result', { jobId, error: (error as Error).message });
      }
    }
  }
}

function parseJsonStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function finish(report: BackportReport, startedAt: Date): BackportReport {
  report.finishedAt = new Date().toISOString();
  log.info('backport run finished', {
    jobId: report.jobId,
    outcome: report.outcome,
    repository: report.repositoryName,
    originalPrId: report.originalPrId,
    targetBranch: report.targetBranch,
    durationMs: Date.now() - startedAt.getTime(),
  });
  return report;
}

/** Flattens evidence for display. */
export function summariseEvidence(evidence: readonly Evidence[]): string {
  return evidence.map((item) => `[${item.source}/${item.confidence}] ${item.detail}`).join('\n');
}
