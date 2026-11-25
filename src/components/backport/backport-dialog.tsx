'use client';

import { useMutation } from '@tanstack/react-query';
import { AlertCircle, Check, ExternalLink, Loader2, Play, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  applySelection,
  groupJobsByBranch,
  jobKey,
  planJobs,
  type BackportJobSpec,
} from '@/components/backport/jobSelection';
import { Button } from '@/components/ui/button';
import type { MatrixResult } from '@/services/backport/matrix';

/**
 * Confirmation, target selection and progress for backport jobs.
 *
 * The brief requires a confirmation summary before execution. Here it does real
 * work: selecting bugs in the matrix says nothing about *which* releases to
 * target, so this expands the selection into concrete
 * (repository, pull request, release) jobs grouped by release, and lets the
 * developer pick. Rehearsing is offered alongside, and does the same work
 * without writing to Azure DevOps.
 */

interface JobOutcome {
  repository: string;
  pullRequestId: number;
  targetBranch: string;
  outcome: string;
  backportBranch: string | null;
  targetPrId: number | null;
  targetPrUrl: string | null;
  conflictFiles: string[];
  warnings: string[];
  error: string | null;
}

interface ExecuteResponse {
  summary: { total: number; prCreated: number; conflicts: number; failed: number; skipped: number };
  results: JobOutcome[];
}

type RunMode = 'rehearse' | 'execute';

export function BackportDialog({
  matrix,
  selected,
  onClose,
  onCompleted,
}: {
  matrix: MatrixResult;
  selected: ReadonlySet<string>;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const candidates = useMemo(() => planJobs(matrix, selected), [matrix, selected]);

  // Exclusions rather than inclusions, so everything starts selected without an
  // initialisation effect copying derived data into state.
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<JobOutcome[] | null>(null);
  const [mode, setMode] = useState<RunMode | null>(null);

  const groups = useMemo(() => groupJobsByBranch(candidates, matrix.columns), [candidates, matrix.columns]);
  const chosen = useMemo(() => applySelection(candidates, deselected), [candidates, deselected]);

  const toggleJob = (job: BackportJobSpec) => {
    setDeselected((current) => {
      const next = new Set(current);
      const key = jobKey(job);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleBranch = (group: { jobs: BackportJobSpec[] }, checked: boolean) => {
    setDeselected((current) => {
      const next = new Set(current);
      for (const job of group.jobs) {
        if (checked) next.delete(jobKey(job));
        else next.add(jobKey(job));
      }
      return next;
    });
  };

  const run = useMutation({
    mutationFn: async (which: RunMode) => {
      setMode(which);
      const items = chosen.map(({ repository, pullRequestId, targetBranch }) => ({
        repository,
        pullRequestId,
        targetBranch,
      }));

      const response = await fetch(
        which === 'execute' ? '/api/backport/execute' : '/api/backport/dry-run',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            which === 'execute' ? { confirm: 'create-pull-requests', items } : { items },
          ),
        },
      );

      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Request failed');
      return payload as ExecuteResponse | { reports: unknown[] };
    },
    onSuccess: (payload, which) => {
      if (which === 'execute' && 'results' in payload) setResults(payload.results);
      onCompleted();
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Create backport pull requests"
    >
      <div className="mt-10 w-full max-w-2xl rounded-lg border border-border bg-surface-overlay shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold">Create backport pull requests</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {selected.size} bug{selected.size === 1 ? '' : 's'} selected ·{' '}
              <span className="tabular">{chosen.length}</span> of{' '}
              <span className="tabular">{candidates.length}</span> missing backport
              {candidates.length === 1 ? '' : 's'} chosen
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X aria-hidden />
            <span className="sr-only">Close</span>
          </Button>
        </div>

        <div className="max-h-[52vh] overflow-y-auto px-5 py-4">
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing to do. The selected bugs have no release that is both missing the fix and
              actionable — already merged, already open as a pull request, or the branch does not
              exist in that repository.
            </p>
          ) : results ? (
            <ResultList results={results} />
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Choose the releases to create pull requests for.
              </p>

              {groups.map((group) => {
                const groupChosen = group.jobs.filter((job) => !deselected.has(jobKey(job)));
                const allChosen = groupChosen.length === group.jobs.length;
                const noneChosen = groupChosen.length === 0;

                return (
                  <div key={group.targetBranch} className="rounded-md border border-border">
                    <label className="flex cursor-pointer items-center gap-2.5 border-b border-border/60 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={allChosen}
                        ref={(element) => {
                          if (element) element.indeterminate = !allChosen && !noneChosen;
                        }}
                        onChange={(event) => toggleBranch(group, event.target.checked)}
                        className="size-4 cursor-pointer accent-primary"
                        aria-label={`Select all backports to ${group.targetBranch}`}
                      />
                      <span className="text-xs font-medium">{group.label}</span>
                      <span className="tabular text-xs text-muted-foreground">
                        {group.targetBranch}
                      </span>
                      <span className="tabular ml-auto text-xs text-muted-foreground">
                        {groupChosen.length}/{group.jobs.length}
                      </span>
                    </label>

                    <ul className="divide-y divide-border/40">
                      {group.jobs.map((job) => {
                        const key = jobKey(job);
                        const isChosen = !deselected.has(key);
                        return (
                          <li key={key}>
                            <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5">
                              <input
                                type="checkbox"
                                checked={isChosen}
                                onChange={() => toggleJob(job)}
                                className="size-3.5 cursor-pointer accent-primary"
                                aria-label={`Backport PR ${job.pullRequestId} in ${job.repository} to ${job.targetBranch}`}
                              />
                              <span className="text-xs text-foreground">{job.repository}</span>
                              <span className="tabular rounded bg-muted px-1 py-px text-xs text-muted-foreground">
                                !{job.pullRequestId}
                              </span>
                              {job.workItemId ? (
                                <span className="tabular text-xs text-muted-foreground">
                                  #{job.workItemId}
                                </span>
                              ) : null}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}

              <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                Rehearsing applies the cherry-pick in a throwaway worktree and reports the diff or
                any conflicts, without pushing. Creating pull requests pushes a branch and opens a
                pull request per job; reviewers are notified and build validation runs.
              </p>
            </div>
          )}

          {run.isError ? (
            <div
              className="mt-3 flex items-start gap-2 rounded-md border p-3 text-xs"
              style={{
                borderColor: 'color-mix(in oklch, var(--status-failed) 30%, transparent)',
                backgroundColor: 'color-mix(in oklch, var(--status-failed) 8%, transparent)',
              }}
            >
              <AlertCircle
                className="mt-0.5 size-3.5 shrink-0"
                style={{ color: 'var(--status-failed)' }}
                aria-hidden
              />
              <p className="break-words">{(run.error as Error).message}</p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3.5">
          <Button variant="outline" size="sm" onClick={onClose}>
            {results ? 'Close' : 'Cancel'}
          </Button>

          {!results ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={chosen.length === 0 || run.isPending}
                onClick={() => run.mutate('rehearse')}
                title="Apply the cherry-pick locally and report the result. Nothing is pushed."
              >
                {run.isPending && mode === 'rehearse' ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Play aria-hidden />
                )}
                Rehearse {chosen.length}
              </Button>

              <Button
                size="sm"
                className="ml-auto"
                disabled={chosen.length === 0 || run.isPending}
                onClick={() => run.mutate('execute')}
                title="Push branches and open pull requests in Azure DevOps"
              >
                {run.isPending && mode === 'execute' ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : null}
                Create {chosen.length} pull request{chosen.length === 1 ? '' : 's'}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ResultList({ results }: { results: JobOutcome[] }) {
  return (
    <ul className="space-y-2">
      {results.map((result) => {
        const ok = result.outcome === 'PR_CREATED';
        const colorVar = ok
          ? 'status-merged'
          : result.outcome === 'CONFLICT'
            ? 'status-conflict'
            : result.outcome === 'SKIPPED_ALREADY_PRESENT'
              ? 'status-skipped'
              : 'status-failed';

        return (
          <li
            key={`${result.repository}-${result.pullRequestId}-${result.targetBranch}`}
            className="rounded-md border border-border p-3 text-xs"
          >
            <div className="flex items-center gap-2">
              {ok ? (
                <Check className="size-3.5" style={{ color: `var(--${colorVar})` }} aria-hidden />
              ) : (
                <AlertCircle
                  className="size-3.5"
                  style={{ color: `var(--${colorVar})` }}
                  aria-hidden
                />
              )}
              <span className="font-medium">{result.repository}</span>
              <span className="tabular text-muted-foreground">
                !{result.pullRequestId} → {result.targetBranch.replace(/^release\//, '')}
              </span>
              <span className="ml-auto" style={{ color: `var(--${colorVar})` }}>
                {result.outcome}
              </span>
            </div>

            {result.targetPrUrl ? (
              <a
                href={result.targetPrUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 text-primary hover:underline"
              >
                PR !{result.targetPrId}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : null}

            {result.conflictFiles.length > 0 ? (
              <p className="mt-1.5 text-muted-foreground">
                Conflicts: {result.conflictFiles.join(', ')}
              </p>
            ) : null}

            {result.warnings.map((warning) => (
              <p key={warning} className="mt-1.5" style={{ color: 'var(--status-conflict)' }}>
                {warning}
              </p>
            ))}

            {result.error ? (
              <p className="mt-1.5 break-words" style={{ color: 'var(--status-failed)' }}>
                {result.error}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
