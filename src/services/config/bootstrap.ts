import { getServerEnv } from '@/lib/config/env';
import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/prisma/client';
import { AdoClient } from '@/services/ado/client';
import { getAuthenticatedIdentity, listRepositories } from '@/services/ado/repositories';
import { reconcileInterruptedJobs } from '@/services/backport/jobStore';

const log = createLogger('bootstrap');

/**
 * First-run configuration.
 *
 * Defaults come from the Phase 0 survey of jblprd/jemsmm, but nothing here is
 * hardcoded into the rest of the app: every value is a database row the
 * settings page can change. The seed exists so the dashboard is useful on the
 * first load instead of empty.
 */

const DEFAULT_REPOSITORIES = [
  'core-sqldatabase',
  'core-consolidated-database',
  'core-application',
  'mms-wip-service',
  'component-usage',
  'packout',
  'wip-operations',
] as const;

/**
 * Release columns, oldest first.
 *
 * Phase 0 measured the propagation direction rather than assuming it: of 81
 * fixes spanning more than one version line, 60% landed on 26.2 first, so the
 * default source is the oldest line and fixes move forward. Within a version,
 * PRE precedes .0 in 95% of cases.
 */
const DEFAULT_RELEASE_BRANCHES = [
  { branchName: 'release/26.2.1.PRE', versionLabel: '26.2', stageLabel: 'PRE', isDefaultSource: true },
  { branchName: 'release/26.2.1.0', versionLabel: '26.2', stageLabel: '0', isDefaultSource: false },
  // A patch line of its own rather than a third stage of 26.2: grouping it
  // under the 26.2 header would read as "26.2 stage 2.0", which is not a stage.
  { branchName: 'release/26.2.2.0', versionLabel: '26.2.2', stageLabel: '0', isDefaultSource: false },
  { branchName: 'release/26.5.1.PRE', versionLabel: '26.5', stageLabel: 'PRE', isDefaultSource: false },
  { branchName: 'release/26.5.1.0', versionLabel: '26.5', stageLabel: '0', isDefaultSource: false },
  { branchName: 'release/26.8.1.PRE', versionLabel: '26.8', stageLabel: 'PRE', isDefaultSource: false },
  { branchName: 'release/26.8.1.0', versionLabel: '26.8', stageLabel: '0', isDefaultSource: false },
  // 26.12 is the newest line, so it sorts last: 12 > 8 by release order, not
  // by string order.
  { branchName: 'release/26.12.1.RC', versionLabel: '26.12', stageLabel: 'RC', isDefaultSource: false },
] as const;

/**
 * Registers the default release columns.
 *
 * Reconciles rather than seeding only on an empty table, for the same reason as
 * the repositories below: adding a release line here has to reach an install
 * that already has rows, which is every install after the first run.
 *
 * `enabled` is never written, so a column the user unticked on the settings
 * page stays unticked. `sortOrder` is rewritten from the array position on
 * every call, because a new line inserted in the middle has to push the later
 * ones along - the two-row matrix header only lines up while a version's
 * stages are adjacent.
 */
export async function ensureReleaseBranches(): Promise<void> {
  const known = new Set(
    (await prisma.releaseBranchConfig.findMany({ select: { branchName: true } })).map(
      (branch) => branch.branchName,
    ),
  );

  let added = 0;
  for (const [index, branch] of DEFAULT_RELEASE_BRANCHES.entries()) {
    if (!known.has(branch.branchName)) added += 1;

    await prisma.releaseBranchConfig.upsert({
      where: { branchName: branch.branchName },
      create: { ...branch, sortOrder: index },
      update: {
        versionLabel: branch.versionLabel,
        stageLabel: branch.stageLabel,
        sortOrder: index,
      },
    });
  }

  if (added > 0) log.info('registered release branches', { added });
}

export async function ensureAppConfig(): Promise<void> {
  const existing = await prisma.appConfig.findFirst();

  if (existing) {
    // Backfill the identity for config rows created before the "only my pull
    // requests" filter existed. Without this the filter silently does nothing.
    if (!existing.adoUserId) {
      try {
        const identity = await getAuthenticatedIdentity(AdoClient.fromEnv());
        await prisma.appConfig.update({
          where: { id: existing.id },
          data: { adoUserId: identity.id, adoUserDisplayName: identity.displayName },
        });
        log.info('backfilled ADO identity on existing config', { id: identity.id });
      } catch (error) {
        log.warn('could not backfill ADO identity', { error: (error as Error).message });
      }
    }
    return;
  }

  const env = getServerEnv();

  // Prefer the PAT owner's identity so commits this tool creates are
  // attributable, rather than inheriting a personal global git config.
  let committerName = env.GIT_AUTHOR_NAME;
  let committerEmail = env.GIT_AUTHOR_EMAIL ?? '';
  let adoUserId: string | null = null;
  let adoUserDisplayName: string | null = null;

  try {
    const identity = await getAuthenticatedIdentity(AdoClient.fromEnv());
    committerName = identity.displayName || committerName;
    committerEmail = identity.email || committerEmail;
    // Verified to match PR.createdBy.id, so it can drive the "only mine" filter.
    adoUserId = identity.id;
    adoUserDisplayName = identity.displayName;
  } catch (error) {
    log.warn('could not resolve ADO identity; using env defaults', {
      error: (error as Error).message,
    });
  }

  await prisma.appConfig.create({
    data: {
      id: 1,
      adoOrgUrl: env.ADO_ORG_URL,
      adoProject: env.ADO_PROJECT,
      gitExecutable: env.GIT_EXECUTABLE,
      mirrorDir: env.GIT_MIRROR_DIR,
      worktreeDir: env.GIT_WORKTREE_DIR,
      committerName,
      committerEmail,
      adoUserId,
      adoUserDisplayName,
      concurrency: env.BACKPORT_CONCURRENCY,
    },
  });
  log.info('seeded app config', { committerName, committerEmail });
}

/**
 * Registers the default repositories.
 *
 * Upserts rather than seeding only on an empty table, so adding a repository to
 * DEFAULT_REPOSITORIES picks it up on an existing install. Repositories the
 * user disabled stay disabled: `enabled` is deliberately not overwritten.
 */
export async function ensureTrackedRepositories(): Promise<void> {
  const known = await prisma.trackedRepository.findMany({ select: { name: true } });
  const knownNames = new Set(known.map((repo) => repo.name));

  const missing = DEFAULT_REPOSITORIES.filter((name) => !knownNames.has(name));
  if (missing.length === 0) return;

  const repositories = await listRepositories(AdoClient.fromEnv());
  const byName = new Map(repositories.map((repo) => [repo.name, repo]));

  let added = 0;
  for (const [index, name] of DEFAULT_REPOSITORIES.entries()) {
    if (knownNames.has(name)) continue;

    const repo = byName.get(name);
    if (!repo) {
      log.warn('default repository not found in ADO; skipping', { name });
      continue;
    }

    await prisma.trackedRepository.upsert({
      where: { adoRepositoryId: repo.id },
      create: {
        name: repo.name,
        adoRepositoryId: repo.id,
        defaultBranch: repo.defaultBranch?.replace(/^refs\/heads\//, '') ?? null,
        sortOrder: index,
      },
      update: { name: repo.name, sortOrder: index },
    });
    added += 1;
  }

  if (added > 0) log.info('registered tracked repositories', { added });
}

/**
 * Jobs left PROCESSING by a crash or a dev-server restart are cleared once per
 * process. Without this the dashboard would show a cell spinning forever that
 * no retry could clear.
 */
let reconciled = false;

async function reconcileOnce(): Promise<void> {
  if (reconciled) return;
  reconciled = true;
  try {
    await reconcileInterruptedJobs();
  } catch (error) {
    log.warn('could not reconcile interrupted jobs', { error: (error as Error).message });
  }
}

/** Idempotent. Safe to call on every request that needs configuration. */
export async function bootstrap(): Promise<void> {
  await ensureReleaseBranches();
  await ensureAppConfig();
  await ensureTrackedRepositories();
  await reconcileOnce();
}
