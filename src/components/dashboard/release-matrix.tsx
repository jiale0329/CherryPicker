'use client';

import { BookmarkX, ChevronDown, ChevronRight, ExternalLink, Info } from 'lucide-react';

import { CellMark } from '@/components/dashboard/cell-mark';
import { workItemUrl } from '@/lib/ado/urls';
import { groupColumnsByVersion } from '@/lib/format';
import { cn } from '@/lib/utils';
import type {
  MatrixBugCell,
  MatrixBugRow,
  MatrixCell,
  MatrixFix,
  MatrixResult,
} from '@/services/backport/matrix';
import { describeStatus } from '@/types/backport/status';

/**
 * Work item states meaning the bug is still being worked. The project uses a
 * custom set, not the Agile defaults: Done, Fixed, Back Merged, Closed
 * Rejected, Confirmed Fixed, Ready to Test.
 *
 * Used only for emphasis. It does not decide whether a backport is needed, as
 * most fixes are Done while still missing backports.
 */
const WORK_ITEM_STATE_IS_OPEN = new Set([
  'Fixed',
  'Confirmed Fixed',
  'Ready to Test',
  'Active',
  'New',
]);

/**
 * The release tracking matrix.
 *
 * One row per bug item, with a nested row per repository fixing it, because the
 * same bug is often fixed in several repositories and each one is backported
 * separately. A bug row shows the aggregate per release; the nested rows carry
 * the real, actionable cells.
 */
export function ReleaseMatrix({
  matrix,
  selectedBugs,
  expandedBugs,
  orgUrl,
  project,
  onToggleBug,
  onToggleAll,
  onToggleExpand,
  onOpenCell,
  onUnwatch,
}: {
  matrix: MatrixResult;
  selectedBugs: ReadonlySet<string>;
  expandedBugs: ReadonlySet<string>;
  orgUrl?: string | null;
  project?: string | null;
  onToggleBug: (key: string) => void;
  onToggleAll: (checked: boolean) => void;
  onToggleExpand: (key: string) => void;
  onOpenCell: (bug: MatrixBugRow, fix: MatrixFix, cell: MatrixCell) => void;
  onUnwatch: (workItemId: number) => void;
}) {
  const allSelected =
    matrix.rows.length > 0 && matrix.rows.every((row) => selectedBugs.has(row.key));
  const versionGroups = groupColumnsByVersion(matrix.columns);

  return (
    <div className="overflow-x-auto overflow-y-visible rounded-lg border border-border bg-card">
      {/*
        `table-fixed` with an explicit colgroup is what actually caps the bug
        item column. With auto layout, a 120-character work item title such as
        "INC1979374 | PUN | PRD | Backflush | Panel WIP Backflush Message Data
        is Missing Route and Route Step Details When Using Parser" widened the
        column and squeezed the release columns, however much truncation the
        cell asked for. A min-width keeps the release columns usable and lets
        the wrapper scroll instead of compressing them.

        The minimum is computed from the column count rather than fixed: the
        four leading columns are 34.75rem (2.75 + 2 + 22 + 8) and each release
        column is the 5rem its `col` asks for. A hardcoded width would either
        compress the columns once a release line is added or force a scrollbar
        once one is unticked.
      */}
      <table
        className="w-full table-fixed border-collapse text-sm"
        style={{ minWidth: `${34.75 + matrix.columns.length * 5}rem` }}
      >
        <colgroup>
          <col className="w-11" />
          <col className="w-8" />
          <col className="w-[22rem]" />
          <col className="w-32" />
          {matrix.columns.map((column) => (
            <col key={column.branchName} className="w-20" />
          ))}
        </colgroup>

        <thead className="sticky top-0 z-10">
          <tr className="border-b border-border bg-surface-raised">
            <th rowSpan={2} className="w-10 px-3 py-2.5 text-left">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(event) => onToggleAll(event.target.checked)}
                aria-label="Select all bugs on this page"
                className="size-4 cursor-pointer accent-primary"
              />
            </th>
            <th rowSpan={2} className="w-8 px-1 py-2.5" />
            <th
              rowSpan={2}
              className="px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Bug item
            </th>
            <th
              rowSpan={2}
              className="px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              Repos
            </th>
            {/*
              Two header rows: a version group spanning its stages, then the
              stage labels. Three groups read far faster than six flat columns,
              and it matches how a release is actually thought about - a
              version, with a PRE and a .0 stage.
            */}
            {versionGroups.map((group) => (
              <th
                key={group.versionLabel}
                colSpan={group.stages.length}
                className="border-l border-border-strong px-2 pb-1 pt-2.5 text-center text-xs font-semibold tracking-wide text-foreground"
              >
                <span className="tabular">{group.versionLabel}</span>
              </th>
            ))}
          </tr>
          <tr className="border-b border-border bg-surface-raised">
            {/* The four leading columns span both header rows. */}
            {versionGroups.map((group) =>
              group.stages.map((stage, stageIndex) => (
                <th
                  key={stage.branchName}
                  title={stage.branchName}
                  className={cn(
                    'px-2 pb-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground',
                    stageIndex === 0 && 'border-l border-border-strong',
                  )}
                >
                  {stage.stageLabel}
                </th>
              )),
            )}
          </tr>
        </thead>

        <tbody>
          {matrix.rows.map((bug, index) => {
            const isExpanded = expandedBugs.has(bug.key);
            const isSelected = selectedBugs.has(bug.key);

            return (
              <BugRowGroup
                key={bug.key}
                rowIndex={index}
                bug={bug}
                matrix={matrix}
                isExpanded={isExpanded}
                isSelected={isSelected}
                orgUrl={orgUrl}
                project={project}
                onToggleBug={onToggleBug}
                onToggleExpand={onToggleExpand}
                onOpenCell={onOpenCell}
                onUnwatch={onUnwatch}
              />
            );
          })}
        </tbody>
      </table>

      {matrix.rows.length === 0 ? <EmptyState matrix={matrix} /> : null}
    </div>
  );
}

/**
 * Empty state, worded for the reason it is empty.
 *
 * An empty watchlist is the normal first-run state and says nothing about
 * whether data has been synced, so advising a refresh there would be wrong and
 * would hide the fact that the all-bugs view has plenty.
 */
function EmptyState({ matrix }: { matrix: MatrixResult }) {
  const watchlistEmpty = matrix.scope.watchedRows === 0;
  const hasOtherBugs = matrix.scope.allRows > 0;

  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <Info className="size-5 text-muted-foreground" aria-hidden />
      {watchlistEmpty && hasOtherBugs ? (
        <>
          <p className="text-sm font-medium">Your watchlist is empty</p>
          <p className="max-w-md text-xs text-muted-foreground">
            Add a bug by its work item number above, or switch to{' '}
            <span className="font-medium">All bugs</span> to browse the{' '}
            <span className="tabular">{matrix.scope.allRows}</span> discovered by the full sync
            {matrix.scope.allMissingBackports > 0 ? (
              <>
                , which are missing{' '}
                <span className="tabular">{matrix.scope.allMissingBackports}</span> backports
                between them
              </>
            ) : null}
            .
          </p>
        </>
      ) : hasOtherBugs ? (
        <>
          <p className="text-sm font-medium">No bug items match</p>
          <p className="max-w-md text-xs text-muted-foreground">
            The current filters exclude everything in this view. Clear them, or switch scope.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium">Nothing synced yet</p>
          <p className="max-w-md text-xs text-muted-foreground">
            Press Refresh to read completed pull requests from Azure DevOps, or add a bug by its
            work item number above.
          </p>
        </>
      )}
    </div>
  );
}

function BugRowGroup({
  bug,
  rowIndex,
  matrix,
  isExpanded,
  isSelected,
  orgUrl,
  project,
  onToggleBug,
  onToggleExpand,
  onOpenCell,
  onUnwatch,
}: {
  bug: MatrixBugRow;
  rowIndex: number;
  matrix: MatrixResult;
  isExpanded: boolean;
  isSelected: boolean;
  orgUrl?: string | null;
  project?: string | null;
  onToggleBug: (key: string) => void;
  onToggleExpand: (key: string) => void;
  onOpenCell: (bug: MatrixBugRow, fix: MatrixFix, cell: MatrixCell) => void;
  onUnwatch: (workItemId: number) => void;
}) {
  // A bug fixed in exactly one repository has no aggregate worth collapsing, so
  // its real cells are shown inline and expanding only adds PR detail.
  const singleRepo = bug.fixes.length === 1;
  const hasNoFixes = bug.fixes.length === 0;
  const Chevron = isExpanded ? ChevronDown : ChevronRight;
  const adoUrl = workItemUrl(orgUrl, project, bug.workItemId);

  return (
    <>
      <tr
        className={cn(
          'border-b border-border transition-colors duration-150',
          // Alternating rows, so the eye can follow one bug across six release
          // columns without losing its place.
          isSelected
            ? 'bg-primary/10'
            : cn(rowIndex % 2 === 1 && 'bg-row-stripe', 'hover:bg-accent/70'),
        )}
      >
        <td className="px-3 py-2.5 align-top">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleBug(bug.key)}
            aria-label={`Select bug ${bug.workItemId ?? bug.title}`}
            className="size-4 cursor-pointer accent-primary"
          />
        </td>

        <td className="px-1 py-2.5 align-top">
          {hasNoFixes ? null : (
            <button
              type="button"
              onClick={() => onToggleExpand(bug.key)}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? 'Collapse repositories' : 'Expand repositories'}
              className="cursor-pointer rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <Chevron className="size-4" aria-hidden />
            </button>
          )}
        </td>

        <td className="px-3 py-2.5 align-top">
          <div className="min-w-0">
            {/*
              The work item opens in a new tab, never in place: the dashboard
              holds scope, filters, selection and expansion state that
              navigating away would discard, and triage usually means reading
              the bug and coming back.

              A cell is a separate target with its own drawer, so the link is
              scoped to the identity block rather than the whole row.
            */}
            {adoUrl ? (
              <a
                href={adoUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open work item ${bug.workItemId} in Azure DevOps, in a new tab`}
                className="group flex cursor-pointer items-start gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <WorkItemChip bug={bug} linked />
                <BugTitle title={bug.title} linked />
              </a>
            ) : (
              <div className="flex items-start gap-2">
                <WorkItemChip bug={bug} />
                <BugTitle title={bug.title} />
              </div>
            )}

            {/*
              Two pieces of metadata, not five.
              Dropped: the "mine" chip (the Watchlist tab and the sort order
              already express ownership), the assignee name (low value in a
              list, present in the drawer), and the chip styling around the
              state. Kept: work item state, and the missing count, which is the
              only number that drives action.
            */}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              {bug.workItemState ? (
                <span
                  title={`Work item state: ${bug.workItemState}`}
                  style={
                    WORK_ITEM_STATE_IS_OPEN.has(bug.workItemState)
                      ? { color: 'var(--foreground)' }
                      : undefined
                  }
                >
                  {bug.workItemState}
                </span>
              ) : null}

              {bug.missingCount > 0 ? (
                <span
                  className="tabular font-medium"
                  style={{ color: 'var(--status-conflict)' }}
                  title="Expected backports still missing, summed across repositories"
                >
                  {bug.missingCount} missing
                </span>
              ) : null}
            </p>
          </div>
        </td>

        <td className="px-3 py-2.5 align-top">
          <div className="flex items-center gap-1.5">
            <span
              className="tabular text-xs text-muted-foreground"
              title={bug.repositories.join('\n')}
            >
              {hasNoFixes ? '—' : singleRepo ? bug.repositories[0] : `${bug.fixes.length} repos`}
            </span>
            {bug.isWatched && bug.workItemId ? (
              <button
                type="button"
                onClick={() => onUnwatch(bug.workItemId!)}
                title="Remove from watchlist. Cached pull requests are kept, so the bug stays in All bugs."
                className="cursor-pointer rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <BookmarkX className="size-3.5" aria-hidden />
                <span className="sr-only">Remove bug {bug.workItemId} from watchlist</span>
              </button>
            ) : null}
          </div>
        </td>

        {hasNoFixes ? (
          <td
            colSpan={matrix.columns.length}
            className="px-3 py-2.5 text-xs text-muted-foreground"
          >
            No pull requests found in the tracked repositories yet.
          </td>
        ) : null}

        {hasNoFixes
          ? null
          : matrix.columns.map((column) => {
            if (singleRepo) {
              const fix = bug.fixes[0];
              const cell = fix.cells.find((item) => item.branchName === column.branchName);
              return (
                <td key={column.branchName} className="px-3 py-2.5 text-center align-top">
                  {cell ? (
                    <FixCell bug={bug} fix={fix} cell={cell} onOpen={onOpenCell} />
                  ) : null}
                </td>
              );
            }

            const aggregate = bug.cells.find((item) => item.branchName === column.branchName);
            return (
              <td key={column.branchName} className="px-3 py-2.5 text-center align-top">
                {aggregate ? <AggregateCell cell={aggregate} /> : null}
              </td>
            );
          })}
      </tr>

      {isExpanded
        ? bug.fixes.map((fix) => (
          <tr
            key={fix.key}
            // Inset and sunken, so a nested repository row is never mistaken
            // for another bug once rows are striped.
            className="border-b border-border/70 bg-surface-sunken"
          >
            <td />
            <td />
            <td className="px-3 py-2 pl-8 align-top">
              <div className="flex items-start gap-2">
                <span className="tabular mt-px shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  !{fix.originPullRequestId}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-xs text-foreground" title={fix.title}>
                    {fix.title}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {fix.author} · origin{' '}
                    <span className="tabular">
                      {fix.originBranch.replace(/^release\//, '')}
                    </span>
                  </p>
                </div>
              </div>
            </td>
            <td className="px-3 py-2 align-top">
              <span className="text-xs text-muted-foreground">{fix.repositoryName}</span>
            </td>
            {matrix.columns.map((column) => {
              const cell = fix.cells.find((item) => item.branchName === column.branchName);
              return (
                <td key={column.branchName} className="px-3 py-2 text-center align-top">
                  {cell ? (
                    <FixCell bug={bug} fix={fix} cell={cell} onOpen={onOpenCell} />
                  ) : null}
                </td>
              );
            })}
          </tr>
        ))
        : null}
    </>
  );
}

/**
 * The `#1507096` badge, or a placeholder when a fix carries no work item.
 *
 * `linked` only changes the hover colours. The anchor is the parent, so this
 * never nests an interactive element inside another.
 */
function WorkItemChip({ bug, linked }: { bug: MatrixBugRow; linked?: boolean }) {
  if (!bug.workItemId) {
    return (
      <span className="mt-px shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
        no work item
      </span>
    );
  }

  return (
    <span
      className={cn(
        'tabular mt-px shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground',
        linked &&
        'transition-colors duration-150 group-hover:bg-primary/10 group-hover:text-primary',
      )}
      title={
        linked
          ? `${bug.workItemType ?? 'Work item'} ${bug.workItemId} — opens in Azure DevOps in a new tab`
          : `${bug.workItemType ?? 'Work item'} ${bug.workItemId}`
      }
    >
      #{bug.workItemId}
      {linked ? <ExternalLink className="ml-1 inline size-3 align-[-1px]" aria-hidden /> : null}
    </span>
  );
}

/**
 * Two lines rather than one, then ellipsis. Work item titles here are long and
 * front-loaded with site and incident codes ("INC1979374 | PUN | PRD |
 * Backflush | …"), so a single line often cut off before the part that
 * identifies the bug. The full text is in the tooltip and the detail drawer.
 */
function BugTitle({ title, linked }: { title: string; linked?: boolean }) {
  return (
    <p
      className={cn(
        'line-clamp-2 font-medium leading-snug text-foreground',
        linked && 'transition-colors duration-150 group-hover:text-primary group-hover:underline',
      )}
      title={title}
    >
      {title}
    </p>
  );
}

/** Aggregate indicator for a bug spanning several repositories. */
function AggregateCell({ cell }: { cell: MatrixBugCell }) {
  if (!cell.expected) {
    return (
      <div
        className="cell-unavailable mx-auto h-7 w-16 rounded-md border border-border/50"
        title="No backport expected on this release"
        aria-label="Not applicable"
      />
    );
  }

  const complete = cell.missing === 0;
  return (
    <span
      className="inline-flex items-center gap-1"
      title={
        complete
          ? `Merged in all ${cell.expectedRepos} repositories`
          : `${cell.mergedRepos} of ${cell.expectedRepos} repositories merged — ${cell.label}. Expand the row to act on each.`
      }
    >
      <CellMark status={cell.status} />
      {/* The ratio only earns space when repositories disagree. */}
      {complete ? null : (
        <span className="tabular text-xs text-muted-foreground">
          {cell.mergedRepos}/{cell.expectedRepos}
        </span>
      )}
    </span>
  );
}

function FixCell({
  bug,
  fix,
  cell,
  onOpen,
}: {
  bug: MatrixBugRow;
  fix: MatrixFix;
  cell: MatrixCell;
  onOpen: (bug: MatrixBugRow, fix: MatrixFix, cell: MatrixCell) => void;
}) {
  const descriptor = describeStatus(cell.status);

  // Not applicable: still rendered, so the row keeps its column rhythm, but
  // inert and unclickable.
  if (!cell.expected) {
    return (
      <CellMark
        status="UNAVAILABLE"
        title={cell.evidence[0]?.detail ?? descriptor.description}
        className="mx-auto"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(bug, fix, cell)}
      className="inline-flex cursor-pointer items-center justify-center rounded outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60"
      title={
        cell.isOrigin
          ? `Origin of this fix — PR !${fix.originPullRequestId} on ${cell.branchName}. Click for detail.`
          : `${descriptor.label} — ${descriptor.description}. Click for detail.`
      }
    >
      <CellMark
        status={cell.status}
        isOrigin={cell.isOrigin}
        needsReview={cell.likelyAlreadyPresent}
      />
    </button>
  );
}
