import { prisma } from '@/lib/prisma/client';
import { handle, ok } from '@/lib/validation/http';
import { bootstrap } from '@/services/config/bootstrap';

export const dynamic = 'force-dynamic';

/**
 * Repository and release-branch configuration for the header selectors.
 * Seeds defaults on first call so the dashboard is never empty on a fresh clone.
 */
export async function GET() {
  return handle('config', async () => {
    await bootstrap();

    const [repositories, releaseBranches] = await Promise.all([
      prisma.trackedRepository.findMany({
        where: { enabled: true },
        orderBy: { sortOrder: 'asc' },
        select: { name: true, adoRepositoryId: true, defaultBranch: true },
      }),
      prisma.releaseBranchConfig.findMany({
        where: { enabled: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    const defaultSource =
      releaseBranches.find((branch) => branch.isDefaultSource)?.branchName ??
      releaseBranches[0]?.branchName ??
      null;

    const config = await prisma.appConfig.findFirst();

    let excludedWorkItemStates: string[] = [];
    try {
      const stored = JSON.parse(config?.excludedWorkItemStatesJson ?? '[]') as unknown;
      if (Array.isArray(stored)) {
        excludedWorkItemStates = stored.filter((s): s is string => typeof s === 'string');
      }
    } catch {
      excludedWorkItemStates = [];
    }

    return ok({
      // Needed to build pull request web links in the detail drawer.
      adoOrgUrl: config?.adoOrgUrl ?? null,
      adoProject: config?.adoProject ?? null,
      identity: config?.adoUserId
        ? { id: config.adoUserId, displayName: config.adoUserDisplayName ?? '' }
        : null,
      defaultOnlyMine: config?.defaultOnlyMine ?? false,
      excludedWorkItemStates,
      repositories,
      releaseBranches: releaseBranches.map((branch) => ({
        branchName: branch.branchName,
        versionLabel: branch.versionLabel,
        stageLabel: branch.stageLabel,
        isDefaultSource: branch.isDefaultSource,
      })),
      defaultRepository: repositories[0]?.name ?? null,
      defaultSource,
    });
  });
}
