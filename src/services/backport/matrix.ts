import { prisma } from '@/lib/prisma/client';
import {
  parseBackportBranch,
  resolveCellStatus,
  type CellResolution,
  type TargetPullRequestEvidence,
} from '@/services/backport/correlation';
import {
  categoriseRow,
  describeCategory,
  isWorkItemOpen,
  ROW_CATEGORIES,
  type RowCategory,
} from '@/types/backport/category';
import { describeStatus, isBackportStatus, type MatrixCellStatus } from '@/types/backport/status';

/**
 * Builds the release tracking matrix, grouped by bug item.
 *
 * Two levels, because one bug is frequently fixed in several repositories and
 * each repository has to be backported on its own:
 *
 *   Bug item (work item)                 aggregate status per release
 *     └─ fix in core-application         real cells, actionable
 *     └─ fix in core-sqldatabase         real cells, actionable
 *
 * A bug is identified by the work item id embedded in the source branch
 * (`hotfix/{id}-{slug}`), which survives cherry-picking where a commit sha does
 * not. Pull requests carrying no work item id become a single-fix bug row of
 * their own, scoped to their repository so unrelated ones never merge.
 *
 * Each fix has an *origin*, the earliest release branch it reached, derived
 * from the data. Only branches after the origin count as expected backports, so
 * a fix born in 26.8 is not reported as missing from 26.2.
 */

export interface MatrixColumn {
  branchName: string;
  versionLabel: string;
  stageLabel: string;
  sortOrder: number;
}

export interface MatrixCell {
  branchName: string;
  status: MatrixCellStatus;
  label: string;
  colorVar: string;
  confidence: CellResolution['confidence'];
  likelyAlreadyPresent: boolean;
  targetPrId?: number;
  evidence: CellResolution['evidence'];
  actionable: boolean;
  isOrigin: boolean;
  /**
   * False when no backport is expected here: the branch does not exist in this
   * repository, or it precedes the fix's origin. Inert, and excluded from counts.
   */
  expected: boolean;
}

/** One repository's fix for a bug. This is the unit a backport job acts on. */
export interface MatrixFix {
  key: string;
  repositoryName: string;
  adoRepositoryId: string;

  title: string;
  author: string;
  authorId: string | null;
  originBranch: string;
  originPullRequestId: number;
  originClosedAt: string | null;
  sourceBranch: string;
  mergeStrategy: string | null;
  lastMergeCommitSha: string | null;

  missingCount: number;
  cells: MatrixCell[];
}

/** Aggregate of one release column across every repository fixing this bug. */
export interface MatrixBugCell {
  branchName: string;
  status: MatrixCellStatus;
  label: string;
  colorVar: string;
  /** Repositories where a backport is expected on this branch. */
  expectedRepos: number;
  /** Of those, how many have the fix merged. */
  mergedRepos: number;
  missing: number;
  expected: boolean;
}

export interface MatrixBugRow {
  key: string;
  workItemId: number | null;
  workItemState: string | null;
  workItemType: string | null;
  assignedTo: string | null;

  /** Work item title when known, otherwise the originating PR title. */
  title: string;

  authoredByMe: boolean;
  assignedToMe: boolean;
  isMine: boolean;
  isWorkItemOpen: boolean;
  category: RowCategory;
  /** Pinned to the watchlist. */
  isWatched: boolean;

  repositories: string[];
  missingCount: number;
  latestClosedAt: string | null;

  fixes: MatrixFix[];
  cells: MatrixBugCell[];
}

export interface MatrixSummary {
  totalFixes: number;
  fullyBackported: number;
  outstanding: number;
  awaitingPrApproval: number;
  failedOrConflicted: number;
}

export interface MatrixResult {
  columns: MatrixColumn[];
  rows: MatrixBugRow[];
  summary: MatrixSummary;
  lastSyncedAt: string | null;
  totalRows: number;
  repositories: string[];
  filtered: {
    totalBeforeFilters: number;
    hiddenRows: number;
    hiddenMissingBackports: number;
  };
  availableWorkItemStates: string[];
  /** Sizes of each scope, so switching views is an informed choice. */
  scope: {
    watchedRows: number;
    allRows: number;
    watchedMissingBackports: number;
    allMissingBackports: number;
  };
  categories: {
    category: RowCategory;
    label: string;
    shortLabel: string;
    description: string;
    colorVar: string;
    rows: number;
    missingBackports: number;
  }[];
}

export interface BuildMatrixOptions {
  existingBranchesByRepo: ReadonlyMap<string, ReadonlySet<string>>;
  search?: string;
  statusFilter?: MatrixCellStatus[];
  repositoryFilter?: string;
  onlyAuthorId?: string;
  excludeWorkItemStates?: readonly string[];
  includeWorkItemStates?: readonly string[];
  onlyOutstanding?: boolean;
  currentUserId?: string | null;
  currentUserDisplayName?: string | null;
  closedWorkItemStates?: readonly string[];
  categoryFilter?: readonly RowCategory[];
  /** Work item ids pinned to the watchlist. */
  watchedWorkItemIds?: ReadonlySet<number>;
  /** Restrict to pinned bugs. The dashboard's default view. */
  watchlistOnly?: boolean;
  page?: number;
  pageSize?: number;
}

function parseReviewerCounts(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as { counts?: boolean }[];
    return Array.isArray(parsed) && parsed.some((reviewer) => reviewer.counts === true);
  } catch {
    return false;
  }
}

/**
 * Display precedence when several repositories disagree on one release.
 * The most urgent state wins, so a single failure is never masked by progress
 * elsewhere.
 */
const URGENCY: readonly MatrixCellStatus[] = [
  'FAILED',
  'CONFLICT',
  'PROCESSING',
  'NOT_STARTED',
  'CHERRY_PICKED',
  'PR_CREATED',
  'PR_APPROVED',
  'SKIPPED',
  'MERGED',
  'UNAVAILABLE',
];

function mostUrgent(statuses: readonly MatrixCellStatus[]): MatrixCellStatus {
  for (const candidate of URGENCY) {
    if (statuses.includes(candidate)) return candidate;
  }
  return 'NOT_STARTED';
}

export async function buildMatrix(options: BuildMatrixOptions): Promise<MatrixResult> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, options.pageSize ?? 25));

  const repositories = await prisma.trackedRepository.findMany({
    where: {
      enabled: true,
      ...(options.repositoryFilter ? { name: options.repositoryFilter } : {}),
    },
    orderBy: { sortOrder: 'asc' },
  });
  const repoById = new Map(repositories.map((repo) => [repo.adoRepositoryId, repo]));

  const releaseBranches = await prisma.releaseBranchConfig.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: 'asc' },
  });

  const columns: MatrixColumn[] = releaseBranches.map((branch) => ({
    branchName: branch.branchName,
    versionLabel: branch.versionLabel,
    stageLabel: branch.stageLabel,
    sortOrder: branch.sortOrder,
  }));
  const branchOrder = new Map(columns.map((column) => [column.branchName, column.sortOrder]));

  const cached = await prisma.cachedPullRequest.findMany({
    where: {
      adoRepositoryId: { in: [...repoById.keys()] },
      targetBranch: { in: columns.map((column) => column.branchName) },
    },
    orderBy: { closedAt: 'asc' },
  });

  const jobs = await prisma.backportJob.findMany({
    where: { adoRepositoryId: { in: [...repoById.keys()] } },
  });
  const jobByKey = new Map(
    jobs.map((job) => [`${job.adoRepositoryId}::${job.originalPrId}::${job.targetBranch}`, job]),
  );

  const closedStates = new Set(options.closedWorkItemStates ?? ['Done', 'Closed Rejected']);

  // --- group pull requests into one fix per repository ----------------------
  const backportOriginByPr = new Map<number, number>();
  for (const pr of cached) {
    const backport = parseBackportBranch(pr.sourceBranch);
    if (backport) backportOriginByPr.set(pr.pullRequestId, backport.originalPrId);
  }

  const prToFix = new Map<number, string>();
  const fixGroups = new Map<string, typeof cached>();

  for (const pr of cached) {
    const origin = backportOriginByPr.get(pr.pullRequestId);
    const inherited = origin !== undefined ? prToFix.get(origin) : undefined;

    const fixKey =
      inherited ??
      (pr.correlationKey
        ? `${pr.adoRepositoryId}::wi:${pr.correlationKey}`
        : `${pr.adoRepositoryId}::pr:${origin ?? pr.pullRequestId}`);

    prToFix.set(pr.pullRequestId, fixKey);
    const list = fixGroups.get(fixKey) ?? [];
    list.push(pr);
    fixGroups.set(fixKey, list);
  }

  const workItemIds = [...new Set(cached.map((pr) => Number(pr.correlationKey)))].filter(
    (id) => Number.isFinite(id) && id > 0,
  );
  const workItems = await prisma.workItemCache.findMany({ where: { id: { in: workItemIds } } });
  const workItemById = new Map(workItems.map((item) => [item.id, item]));

  /** A fix plus the grouping metadata the bug-level pass needs. */
  interface FixEntry {
    fix: MatrixFix;
    correlationKey: string | null;
    prs: typeof cached;
  }

  const fixes: FixEntry[] = [];

  for (const [fixKey, prs] of fixGroups) {
    const repo = repoById.get(prs[0].adoRepositoryId);
    if (!repo) continue;

    const existing = options.existingBranchesByRepo.get(repo.adoRepositoryId) ?? new Set<string>();

    const completed = prs.filter((pr) => pr.status === 'completed');
    const originPr =
      [...(completed.length > 0 ? completed : prs)].sort((a, b) => {
        const orderA = branchOrder.get(a.targetBranch) ?? Number.MAX_SAFE_INTEGER;
        const orderB = branchOrder.get(b.targetBranch) ?? Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0);
      })[0] ?? prs[0];

    const originOrder = branchOrder.get(originPr.targetBranch) ?? 0;

    const cells = columns.map<MatrixCell>((column) => {
      const branchExists = existing.has(column.branchName);
      const isOrigin = column.branchName === originPr.targetBranch;
      const expected = branchExists && (isOrigin || column.sortOrder > originOrder);

      if (!expected) {
        return {
          branchName: column.branchName,
          status: 'UNAVAILABLE',
          label: branchExists ? 'Before origin' : 'No branch',
          colorVar: 'status-unavailable',
          confidence: 'definitive',
          likelyAlreadyPresent: false,
          evidence: [
            {
              source: 'execution-record',
              confidence: 'definitive',
              detail: branchExists
                ? `Precedes the origin (${originPr.targetBranch}); no backport expected.`
                : `${column.branchName} does not exist in ${repo.name}.`,
            },
          ],
          actionable: false,
          isOrigin: false,
          expected: false,
        };
      }

      const evidence: TargetPullRequestEvidence[] = prs
        .filter((pr) => pr.targetBranch === column.branchName)
        .map((pr) => ({
          pullRequestId: pr.pullRequestId,
          state:
            pr.status === 'completed'
              ? ('completed' as const)
              : pr.status === 'abandoned'
                ? ('abandoned' as const)
                : ('active' as const),
          approvedByIndividual: parseReviewerCounts(pr.reviewersJson),
          source: backportOriginByPr.has(pr.pullRequestId)
            ? ('backport-branch-name' as const)
            : ('work-item' as const),
          confidence: 'strong' as const,
        }));

      const job = jobByKey.get(
        `${repo.adoRepositoryId}::${originPr.pullRequestId}::${column.branchName}`,
      );

      const resolution = resolveCellStatus({
        branchExists: true,
        job:
          job && isBackportStatus(job.status)
            ? { status: job.status, targetPrId: job.targetPrId }
            : null,
        targetPullRequests: evidence,
      });

      const descriptor = describeStatus(resolution.status);
      return {
        branchName: column.branchName,
        status: resolution.status,
        label: isOrigin && resolution.status === 'MERGED' ? 'Origin' : descriptor.label,
        colorVar: descriptor.colorVar,
        confidence: resolution.confidence,
        likelyAlreadyPresent: resolution.likelyAlreadyPresent,
        targetPrId: resolution.targetPrId,
        evidence: resolution.evidence,
        actionable: !isOrigin && isActionableCell(resolution.status),
        isOrigin,
        expected: true,
      };
    });

    fixes.push({
      correlationKey: originPr.correlationKey,
      prs,
      fix: {
        key: fixKey,
        repositoryName: repo.name,
        adoRepositoryId: repo.adoRepositoryId,
        title: originPr.title,
        author: originPr.author,
        authorId: originPr.authorId,
        originBranch: originPr.targetBranch,
        originPullRequestId: originPr.pullRequestId,
        originClosedAt: originPr.closedAt?.toISOString() ?? null,
        sourceBranch: originPr.sourceBranch,
        mergeStrategy: originPr.mergeStrategy,
        lastMergeCommitSha: originPr.lastMergeCommitSha,
        missingCount: cells.filter(
          (cell) => cell.expected && !cell.isOrigin && !describeStatus(cell.status).isComplete,
        ).length,
        cells,
      },
    });
  }

  // --- group fixes into bug items (a bug may span repositories) -------------
  const bugGroups = new Map<string, FixEntry[]>();
  for (const entry of fixes) {
    const bugKey = entry.correlationKey
      ? `wi:${entry.correlationKey}`
      : `pr:${entry.fix.adoRepositoryId}:${entry.fix.originPullRequestId}`;
    const list = bugGroups.get(bugKey) ?? [];
    list.push(entry);
    bugGroups.set(bugKey, list);
  }

  const unfiltered: MatrixBugRow[] = [];

  for (const [bugKey, bugEntries] of bugGroups) {
    const workItemId = bugKey.startsWith('wi:') ? Number(bugKey.slice(3)) : null;
    const workItem =
      workItemId !== null && Number.isFinite(workItemId) ? workItemById.get(workItemId) : undefined;

    const sorted = [...bugEntries].sort((a, b) =>
      a.fix.repositoryName.localeCompare(b.fix.repositoryName),
    );
    const sortedFixes = sorted.map((entry) => entry.fix);

    // "Mine" covers both readings of ownership: a pull request I opened, or a
    // work item assigned to me. Union rather than either alone, so neither
    // interpretation hides work.
    const authoredByMe =
      options.currentUserId != null &&
      sorted.some((entry) => entry.prs.some((pr) => pr.authorId === options.currentUserId));
    const assignedToMe =
      options.currentUserDisplayName != null &&
      workItem?.assignedTo != null &&
      workItem.assignedTo === options.currentUserDisplayName;

    const workItemOpen = isWorkItemOpen(workItem?.state ?? null, closedStates);
    const isMine = authoredByMe || assignedToMe;

    const bugCells = columns.map<MatrixBugCell>((column) => {
      const relevant = sortedFixes
        .map((fix) => fix.cells.find((cell) => cell.branchName === column.branchName))
        .filter((cell): cell is MatrixCell => cell !== undefined && cell.expected);

      if (relevant.length === 0) {
        return {
          branchName: column.branchName,
          status: 'UNAVAILABLE',
          label: '—',
          colorVar: 'status-unavailable',
          expectedRepos: 0,
          mergedRepos: 0,
          missing: 0,
          expected: false,
        };
      }

      const merged = relevant.filter((cell) => describeStatus(cell.status).isComplete).length;
      const status =
        merged === relevant.length
          ? 'MERGED'
          : mostUrgent(
            relevant
              .filter((cell) => !describeStatus(cell.status).isComplete)
              .map((cell) => cell.status),
          );

      return {
        branchName: column.branchName,
        status,
        label: describeStatus(status).label,
        colorVar: describeStatus(status).colorVar,
        expectedRepos: relevant.length,
        mergedRepos: merged,
        missing: relevant.length - merged,
        expected: true,
      };
    });

    const latestClosedAt = sortedFixes
      .map((fix) => fix.originClosedAt)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1);

    unfiltered.push({
      key: bugKey,
      workItemId: workItemId !== null && Number.isFinite(workItemId) ? workItemId : null,
      workItemState: workItem?.state ?? null,
      workItemType: workItem?.workItemType ?? null,
      assignedTo: workItem?.assignedTo ?? null,
      title: workItem?.title?.trim() || sortedFixes[0].title,
      authoredByMe,
      assignedToMe,
      isMine,
      isWorkItemOpen: workItemOpen,
      category: categoriseRow({ isMine, isWorkItemOpen: workItemOpen }),
      isWatched: workItemId !== null && (options.watchedWorkItemIds?.has(workItemId) ?? false),
      repositories: sortedFixes.map((fix) => fix.repositoryName),
      missingCount: sortedFixes.reduce((total, fix) => total + fix.missingCount, 0),
      latestClosedAt: latestClosedAt ?? null,
      fixes: sortedFixes,
      cells: bugCells,
    });
  }

  /*
   * Ordering, highest priority first: my open bugs, then bugs with missing
   * backports, then newest. Sorting rather than filtering keeps every bug in
   * every repository on the list while raising the ones likely to need action.
   */
  unfiltered.sort((a, b) => {
    const byCategory =
      describeCategory(a.category).priority - describeCategory(b.category).priority;
    if (byCategory !== 0) return byCategory;

    const aMissing = a.missingCount > 0 ? 0 : 1;
    const bMissing = b.missingCount > 0 ? 0 : 1;
    if (aMissing !== bMissing) return aMissing - bMissing;

    return (b.latestClosedAt ?? '').localeCompare(a.latestClosedAt ?? '');
  });

  /*
   * A pinned bug with no pull requests in the tracked repositories would
   * otherwise produce no row at all, making it indistinguishable from a bug
   * with nothing missing. It gets an explicit placeholder row instead, so
   * nothing the developer pinned can silently vanish.
   */
  if (options.watchedWorkItemIds) {
    const present = new Set(
      unfiltered.map((row) => row.workItemId).filter((id): id is number => id !== null),
    );

    const orphanIds = [...options.watchedWorkItemIds].filter((id) => !present.has(id));
    if (orphanIds.length > 0) {
      const details = await prisma.workItemCache.findMany({ where: { id: { in: orphanIds } } });
      const detailById = new Map(details.map((item) => [item.id, item]));

      for (const id of orphanIds) {
        const detail = detailById.get(id);
        const workItemOpen = isWorkItemOpen(detail?.state ?? null, closedStates);
        const assignedToMe =
          options.currentUserDisplayName != null &&
          detail?.assignedTo != null &&
          detail.assignedTo === options.currentUserDisplayName;

        unfiltered.push({
          key: `wi:${id}`,
          workItemId: id,
          workItemState: detail?.state ?? null,
          workItemType: detail?.workItemType ?? null,
          assignedTo: detail?.assignedTo ?? null,
          title: detail?.title?.trim() || `Work item ${id}`,
          authoredByMe: false,
          assignedToMe,
          isMine: assignedToMe,
          isWorkItemOpen: workItemOpen,
          category: categoriseRow({ isMine: assignedToMe, isWorkItemOpen: workItemOpen }),
          isWatched: true,
          repositories: [],
          missingCount: 0,
          latestClosedAt: null,
          fixes: [],
          cells: columns.map((column) => ({
            branchName: column.branchName,
            status: 'UNAVAILABLE' as const,
            label: '—',
            colorVar: 'status-unavailable',
            expectedRepos: 0,
            mergedRepos: 0,
            missing: 0,
            expected: false,
          })),
        });
      }
    }
  }

  const inScope = options.watchlistOnly
    ? unfiltered.filter((row) => row.isWatched)
    : unfiltered;

  const categories = ROW_CATEGORIES.map((category) => {
    const descriptor = describeCategory(category);
    const inCategory = inScope.filter((row) => row.category === category);
    return {
      category,
      label: descriptor.label,
      shortLabel: descriptor.shortLabel,
      description: descriptor.description,
      colorVar: descriptor.colorVar,
      rows: inCategory.length,
      missingBackports: inCategory.reduce((total, row) => total + row.missingCount, 0),
    };
  });

  // --- filters --------------------------------------------------------------
  let rows = unfiltered;

  // Watchlist scope is applied before the hidden-count is computed, so the
  // "hidden by filters" notice reports what the other filters removed from the
  // chosen scope rather than counting every unpinned bug as hidden.
  if (options.watchlistOnly) {
    rows = rows.filter((row) => row.isWatched);
  }
  const scoped = rows;

  if (options.categoryFilter?.length) {
    const wanted = new Set(options.categoryFilter);
    rows = rows.filter((row) => wanted.has(row.category));
  }

  if (options.onlyAuthorId) {
    rows = rows.filter((row) => row.authoredByMe);
  }

  if (options.includeWorkItemStates?.length) {
    const wanted = new Set(options.includeWorkItemStates);
    rows = rows.filter((row) => row.workItemState !== null && wanted.has(row.workItemState));
  } else if (options.excludeWorkItemStates?.length) {
    const unwanted = new Set(options.excludeWorkItemStates);
    rows = rows.filter((row) => row.workItemState === null || !unwanted.has(row.workItemState));
  }

  if (options.onlyOutstanding) {
    rows = rows.filter((row) => row.missingCount > 0);
  }

  const search = options.search?.trim().toLowerCase();
  if (search) {
    rows = rows.filter(
      (row) =>
        String(row.workItemId ?? '').includes(search) ||
        row.title.toLowerCase().includes(search) ||
        row.repositories.some((name) => name.toLowerCase().includes(search)) ||
        row.fixes.some(
          (fix) =>
            String(fix.originPullRequestId).includes(search) ||
            fix.title.toLowerCase().includes(search) ||
            fix.sourceBranch.toLowerCase().includes(search) ||
            fix.author.toLowerCase().includes(search) ||
            (fix.lastMergeCommitSha ?? '').toLowerCase().startsWith(search),
        ),
    );
  }

  if (options.statusFilter?.length) {
    const wanted = new Set(options.statusFilter);
    rows = rows.filter((row) =>
      row.fixes.some((fix) =>
        fix.cells.some((cell) => cell.expected && !cell.isOrigin && wanted.has(cell.status)),
      ),
    );
  }

  const summary = summarise(rows);
  const totalRows = rows.length;
  const paged = rows.slice((page - 1) * pageSize, page * pageSize);

  const visible = new Set(rows.map((row) => row.key));
  const hidden = scoped.filter((row) => !visible.has(row.key));

  const syncStates = await prisma.syncState.findMany({
    where: { adoRepositoryId: { in: [...repoById.keys()] } },
  });
  const lastSyncedAt = syncStates
    .map((state) => state.lastSyncedAt)
    .filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    columns,
    rows: paged,
    summary,
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    totalRows,
    repositories: repositories.map((repo) => repo.name),
    filtered: {
      totalBeforeFilters: scoped.length,
      hiddenRows: hidden.length,
      hiddenMissingBackports: hidden.reduce((total, row) => total + row.missingCount, 0),
    },
    /** Counts for the scope switch, so neither view hides its size. */
    scope: {
      watchedRows: unfiltered.filter((row) => row.isWatched).length,
      allRows: unfiltered.length,
      watchedMissingBackports: unfiltered
        .filter((row) => row.isWatched)
        .reduce((total, row) => total + row.missingCount, 0),
      allMissingBackports: unfiltered.reduce((total, row) => total + row.missingCount, 0),
    },
    availableWorkItemStates: [...new Set(unfiltered.map((row) => row.workItemState))]
      .filter((state): state is string => state !== null)
      .sort(),
    categories,
  };
}

function isActionableCell(status: MatrixCellStatus): boolean {
  return status === 'NOT_STARTED' || status === 'CONFLICT' || status === 'FAILED';
}

/**
 * Summary cards, counted per bug item.
 *
 * A bug is fully backported only when every expected target in every repository
 * fixing it is MERGED. A cherry-pick or an open pull request does not qualify.
 * Cells that are not expected - absent branch, or a release preceding the
 * origin - are excluded so they neither inflate nor satisfy the count.
 */
export function summarise(rows: readonly MatrixBugRow[]): MatrixSummary {
  let fullyBackported = 0;
  let outstanding = 0;
  let awaitingPrApproval = 0;
  let failedOrConflicted = 0;

  for (const row of rows) {
    const targets = row.fixes.flatMap((fix) =>
      fix.cells.filter((cell) => cell.expected && !cell.isOrigin),
    );

    if (targets.length > 0) {
      if (targets.every((cell) => describeStatus(cell.status).isComplete)) fullyBackported += 1;
      else if (targets.some((cell) => describeStatus(cell.status).isOutstanding)) outstanding += 1;
    }

    if (targets.some((cell) => cell.status === 'PR_CREATED' || cell.status === 'PR_APPROVED')) {
      awaitingPrApproval += 1;
    }
    if (targets.some((cell) => cell.status === 'CONFLICT' || cell.status === 'FAILED')) {
      failedOrConflicted += 1;
    }
  }

  return {
    totalFixes: rows.length,
    fullyBackported,
    outstanding,
    awaitingPrApproval,
    failedOrConflicted,
  };
}
