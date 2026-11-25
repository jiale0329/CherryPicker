'use client';

import { useMutation } from '@tanstack/react-query';
import {
  AlertTriangle,
  ExternalLink,
  GitCommitHorizontal,
  Loader2,
  Play,
  X,
} from 'lucide-react';
import { useState } from 'react';

import { CellMark } from '@/components/dashboard/cell-mark';
import { Button } from '@/components/ui/button';
import { pullRequestUrl, workItemUrl } from '@/lib/ado/urls';
import { cn } from '@/lib/utils';
import type { MatrixBugRow, MatrixCell, MatrixFix } from '@/services/backport/matrix';
import { describeStatus, isActionable } from '@/types/backport/status';

/**
 * Detail panel for a single matrix cell.
 *
 * Replaces a browser `alert()`, which blocked the page and could not hold
 * actions. This is where the full nine-state status vocabulary and the ranked
 * evidence belong: the grid only needs to say "needs action", while deciding
 * what to do about one release needs the reasoning behind that.
 *
 * Conflicts get explicit resolution steps rather than just a file list,
 * because the engine discards its worktree and the developer finishes the job
 * in their own clone.
 */

export interface DrawerTarget {
  bug: MatrixBugRow;
  fix: MatrixFix;
  cell: MatrixCell;
}

interface DryRunReport {
  outcome: string;
  backportBranch: string | null;
  changedFiles: string[];
  conflictFiles: string[];
  diffStat: string | null;
  plan: { mode: string; mergeStrategy: string; rationale: string; commitShas: string[] } | null;
  planRefusal: { code: string; message: string; remedy: string } | null;
  errorMessage: string | null;
  steps: { step: string; ok: boolean; detail: string }[];
}

export function DetailDrawer({
  target,
  orgUrl,
  project,
  onClose,
  onChanged,
}: {
  target: DrawerTarget;
  orgUrl?: string | null;
  project?: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { bug, fix, cell } = target;
  const descriptor = describeStatus(cell.status);
  const [report, setReport] = useState<DryRunReport | null>(null);

  const prUrl = (pullRequestId: number) =>
    pullRequestUrl(orgUrl, project, fix.repositoryName, pullRequestId);

  const run = useMutation({
    mutationFn: async (mode: 'rehearse' | 'execute') => {
      const body =
        mode === 'execute'
          ? {
            confirm: 'create-pull-requests',
            items: [
              {
                repository: fix.repositoryName,
                pullRequestId: fix.originPullRequestId,
                targetBranch: cell.branchName,
              },
            ],
          }
          : {
            repository: fix.repositoryName,
            pullRequestId: fix.originPullRequestId,
            targetBranch: cell.branchName,
          };

      const response = await fetch(
        mode === 'execute' ? '/api/backport/execute' : '/api/backport/dry-run',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Request failed');
      return { mode, payload };
    },
    onSuccess: ({ mode, payload }) => {
      if (mode === 'rehearse') setReport(payload as DryRunReport);
      onChanged();
    },
  });

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border bg-surface-overlay shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Backport detail"
      >
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CellMark status={cell.status} isOrigin={cell.isOrigin} />
              <span className="text-sm font-semibold">
                {cell.isOrigin ? 'Origin' : descriptor.label}
              </span>
              {cell.confidence !== 'definitive' ? (
                <span className="rounded bg-muted px-1 py-px text-xs text-muted-foreground">
                  {cell.confidence} evidence
                </span>
              ) : null}
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={bug.title}>
              {/* Same new-tab rule as the grid: the drawer holds a rehearsal
                  report that navigating away would lose. */}
              {bug.workItemId ? (
                <>
                  {workItemUrl(orgUrl, project, bug.workItemId) ? (
                    <a
                      href={workItemUrl(orgUrl, project, bug.workItemId)!}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                      title={`Open work item ${bug.workItemId} in Azure DevOps, in a new tab`}
                    >
                      #{bug.workItemId}
                    </a>
                  ) : (
                    `#${bug.workItemId}`
                  )}
                  {' · '}
                </>
              ) : null}
              {bug.title}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X aria-hidden />
            <span className="sr-only">Close</span>
          </Button>
        </div>

        {/* body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-xs">
          <Section title="This backport">
            <Row label="Repository" value={fix.repositoryName} />
            <Row label="Target release" value={cell.branchName} mono />
            <Row label="Origin release" value={fix.originBranch} mono />
            <Row
              label="Original PR"
              value={
                prUrl(fix.originPullRequestId) ? (
                  <a
                    href={prUrl(fix.originPullRequestId)!}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    !{fix.originPullRequestId}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : (
                  `!${fix.originPullRequestId}`
                )
              }
            />
            <Row label="Source branch" value={fix.sourceBranch} mono />
            {fix.mergeStrategy ? <Row label="Merged by" value={fix.mergeStrategy} /> : null}
            {fix.lastMergeCommitSha ? (
              <Row
                label="Commit to pick"
                value={
                  <span className="inline-flex items-center gap-1 font-mono">
                    <GitCommitHorizontal className="size-3" aria-hidden />
                    {fix.lastMergeCommitSha.slice(0, 10)}
                  </span>
                }
              />
            ) : null}
            {cell.targetPrId ? (
              <Row
                label="Backport PR"
                value={
                  prUrl(cell.targetPrId) ? (
                    <a
                      href={prUrl(cell.targetPrId)!}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      !{cell.targetPrId}
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : (
                    `!${cell.targetPrId}`
                  )
                }
              />
            ) : null}
          </Section>

          <Section title="Why this status">
            <p className="mb-2 text-muted-foreground">{descriptor.description}</p>
            <ul className="space-y-1.5">
              {cell.evidence.map((item, index) => (
                <li key={index} className="flex gap-2">
                  <span
                    className="mt-1 size-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        item.confidence === 'definitive'
                          ? 'var(--status-merged)'
                          : item.confidence === 'strong'
                            ? 'var(--status-pr-created)'
                            : 'var(--status-conflict)',
                    }}
                  />
                  <span>
                    <span className="text-muted-foreground">[{item.source}]</span> {item.detail}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          {cell.likelyAlreadyPresent ? (
            <Callout tone="status-conflict" icon={<AlertTriangle className="size-3.5" aria-hidden />}>
              An equivalent patch was found on this branch, but that is not proof. It could be the
              same fix applied by hand, or an unrelated change with an identical diff. Rehearse and
              review the diff before creating a pull request.
            </Callout>
          ) : null}

          {cell.status === 'CONFLICT' ? (
            <ConflictHelp fix={fix} cell={cell} />
          ) : null}

          {report ? <RehearsalResult report={report} /> : null}

          {run.isError ? (
            <Callout tone="status-failed" icon={<AlertTriangle className="size-3.5" aria-hidden />}>
              {(run.error as Error).message}
            </Callout>
          ) : null}
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>

          {cell.actionable || isActionable(cell.status) ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={run.isPending}
                onClick={() => run.mutate('rehearse')}
                title="Apply the cherry-pick locally and report the result. Nothing is pushed."
              >
                {run.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
                Rehearse
              </Button>
              <Button
                size="sm"
                className="ml-auto"
                disabled={run.isPending}
                onClick={() => run.mutate('execute')}
                title="Push the branch and open a pull request"
              >
                Create pull request
              </Button>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function ConflictHelp({ fix, cell }: { fix: MatrixFix; cell: MatrixCell }) {
  const sha = fix.lastMergeCommitSha?.slice(0, 12) ?? '<commit>';
  return (
    <Callout tone="status-conflict" icon={<AlertTriangle className="size-3.5" aria-hidden />}>
      <p className="font-medium">This cherry-pick conflicts and needs a human.</p>
      <p className="mt-1">
        The job aborted the pick and discarded its worktree, so nothing is half-applied and nothing
        was pushed. To finish it in your own clone:
      </p>
      <pre className="mt-2 overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xs leading-relaxed">
        {[
          `git fetch origin`,
          `git switch -c fix/${cell.branchName.replace(/^release\//, '')} origin/${cell.branchName}`,
          `git cherry-pick -x ${sha}`,
          `# resolve the conflicts, then:`,
          `git cherry-pick --continue`,
        ].join('\n')}
      </pre>
      <p className="mt-2">Retry here once the fix is merged, and the cell will pick it up.</p>
    </Callout>
  );
}

function RehearsalResult({ report }: { report: DryRunReport }) {
  const clean = report.outcome === 'DRY_RUN_CLEAN';
  return (
    <Section title="Rehearsal result">
      <Row label="Outcome" value={report.outcome} />
      {report.backportBranch ? <Row label="Would create" value={report.backportBranch} mono /> : null}
      {report.plan ? <Row label="Plan" value={report.plan.rationale} /> : null}
      {report.planRefusal ? (
        <>
          <Row label="Refused" value={report.planRefusal.message} />
          <Row label="Remedy" value={report.planRefusal.remedy} />
        </>
      ) : null}
      {report.conflictFiles.length > 0 ? (
        <Row label="Conflicts" value={report.conflictFiles.join(', ')} mono />
      ) : null}
      {report.changedFiles.length > 0 ? (
        <Row label="Would change" value={report.changedFiles.join(', ')} mono />
      ) : null}
      {report.diffStat ? (
        <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-xs">
          {report.diffStat.trim()}
        </pre>
      ) : null}
      {report.errorMessage ? <Row label="Error" value={report.errorMessage} /> : null}
      {clean ? (
        <p className="mt-2 text-muted-foreground">
          Applied cleanly. Nothing was pushed and no pull request was created.
        </p>
      ) : null}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-3">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 break-words', mono && 'font-mono text-xs')}>{value}</span>
    </div>
  );
}

function Callout({
  tone,
  icon,
  children,
}: {
  tone: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-md border p-3"
      style={{
        borderColor: `color-mix(in oklch, var(--${tone}) 30%, transparent)`,
        backgroundColor: `color-mix(in oklch, var(--${tone}) 8%, transparent)`,
      }}
    >
      <div className="flex gap-2">
        <span style={{ color: `var(--${tone})` }} className="mt-0.5 shrink-0">
          {icon}
        </span>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
