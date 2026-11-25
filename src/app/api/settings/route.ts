import { tryGetServerEnv } from '@/lib/config/env';
import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/prisma/client';
import { fail, handle, ok, parseBody } from '@/lib/validation/http';
import { settingsUpdateSchema } from '@/lib/validation/settings';
import { bootstrap } from '@/services/config/bootstrap';

export const dynamic = 'force-dynamic';

const log = createLogger('settings');

function parseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function GET() {
  return handle('settings.get', async () => {
    await bootstrap();

    const [config, repositories, releaseBranches] = await Promise.all([
      prisma.appConfig.findFirst(),
      prisma.trackedRepository.findMany({ orderBy: { sortOrder: 'asc' } }),
      prisma.releaseBranchConfig.findMany({ orderBy: { sortOrder: 'asc' } }),
    ]);

    if (!config) return fail('NOT_CONFIGURED', 'Configuration has not been initialised.', 500);

    const env = tryGetServerEnv();

    return ok({
      // Read-only, sourced from the environment. The PAT is never returned.
      environment: {
        adoOrgUrl: config.adoOrgUrl,
        adoProject: config.adoProject,
        patConfigured: env.ok ? env.env.ADO_PAT.length > 0 : false,
        caBundlePath: env.ok ? (env.env.caBundlePath ?? null) : null,
        adoUserDisplayName: config.adoUserDisplayName,
      },
      git: {
        gitExecutable: config.gitExecutable ?? '',
        mirrorDir: config.mirrorDir,
        worktreeDir: config.worktreeDir,
        committerName: config.committerName,
        committerEmail: config.committerEmail,
      },
      pullRequests: {
        backportBranchTemplate: config.backportBranchTemplate,
        prTitleTemplate: config.prTitleTemplate,
        prDescriptionTemplate: config.prDescriptionTemplate,
        copyReviewersFromOriginal: config.copyReviewersFromOriginal,
        fixedReviewerIds: parseJsonArray(config.fixedReviewerIdsJson),
        createPrAsDraft: config.createPrAsDraft,
      },
      dashboard: {
        defaultOnlyMine: config.defaultOnlyMine,
        closedWorkItemStates: parseJsonArray(config.closedWorkItemStatesJson),
        excludedWorkItemStates: parseJsonArray(config.excludedWorkItemStatesJson),
      },
      engine: {
        concurrency: config.concurrency,
      },
      repositories: repositories.map((repo) => ({
        name: repo.name,
        enabled: repo.enabled,
        defaultBranch: repo.defaultBranch,
      })),
      releaseBranches: releaseBranches.map((branch) => ({
        branchName: branch.branchName,
        versionLabel: branch.versionLabel,
        stageLabel: branch.stageLabel,
        sortOrder: branch.sortOrder,
        enabled: branch.enabled,
      })),
      updatedAt: config.updatedAt.toISOString(),
    });
  });
}

export async function PATCH(request: Request) {
  return handle('settings.patch', async () => {
    const parsed = await parseBody(request, settingsUpdateSchema);
    if (!parsed.ok) return parsed.response;

    await bootstrap();
    const config = await prisma.appConfig.findFirst();
    if (!config) return fail('NOT_CONFIGURED', 'Configuration has not been initialised.', 500);

    const update = parsed.data;

    await prisma.appConfig.update({
      where: { id: config.id },
      data: {
        ...(update.gitExecutable !== undefined ? { gitExecutable: update.gitExecutable } : {}),
        ...(update.mirrorDir !== undefined ? { mirrorDir: update.mirrorDir } : {}),
        ...(update.worktreeDir !== undefined ? { worktreeDir: update.worktreeDir } : {}),
        ...(update.committerName !== undefined ? { committerName: update.committerName } : {}),
        ...(update.committerEmail !== undefined ? { committerEmail: update.committerEmail } : {}),
        ...(update.backportBranchTemplate !== undefined
          ? { backportBranchTemplate: update.backportBranchTemplate }
          : {}),
        ...(update.prTitleTemplate !== undefined ? { prTitleTemplate: update.prTitleTemplate } : {}),
        ...(update.prDescriptionTemplate !== undefined
          ? { prDescriptionTemplate: update.prDescriptionTemplate }
          : {}),
        ...(update.copyReviewersFromOriginal !== undefined
          ? { copyReviewersFromOriginal: update.copyReviewersFromOriginal }
          : {}),
        ...(update.fixedReviewerIds !== undefined
          ? { fixedReviewerIdsJson: JSON.stringify(update.fixedReviewerIds) }
          : {}),
        ...(update.createPrAsDraft !== undefined ? { createPrAsDraft: update.createPrAsDraft } : {}),
        ...(update.concurrency !== undefined ? { concurrency: update.concurrency } : {}),
        ...(update.defaultOnlyMine !== undefined ? { defaultOnlyMine: update.defaultOnlyMine } : {}),
        ...(update.closedWorkItemStates !== undefined
          ? { closedWorkItemStatesJson: JSON.stringify(update.closedWorkItemStates) }
          : {}),
        ...(update.excludedWorkItemStates !== undefined
          ? { excludedWorkItemStatesJson: JSON.stringify(update.excludedWorkItemStates) }
          : {}),
      },
    });

    if (update.enabledRepositories) {
      const enabled = new Set(update.enabledRepositories);
      const all = await prisma.trackedRepository.findMany({ select: { name: true } });
      for (const repo of all) {
        await prisma.trackedRepository.update({
          where: { name: repo.name },
          data: { enabled: enabled.has(repo.name) },
        });
      }
    }

    if (update.enabledReleaseBranches) {
      const enabled = new Set(update.enabledReleaseBranches);
      const all = await prisma.releaseBranchConfig.findMany({ select: { branchName: true } });
      for (const branch of all) {
        await prisma.releaseBranchConfig.update({
          where: { branchName: branch.branchName },
          data: { enabled: enabled.has(branch.branchName) },
        });
      }
    }

    log.info('settings updated', { fields: Object.keys(update) });
    return ok({ ok: true });
  });
}
