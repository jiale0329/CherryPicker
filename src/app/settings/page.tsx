'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, Check, Loader2, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckboxRow, Field, TextArea, TextInput } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';

interface SettingsResponse {
  environment: {
    adoOrgUrl: string;
    adoProject: string;
    patConfigured: boolean;
    caBundlePath: string | null;
    adoUserDisplayName: string | null;
  };
  git: {
    gitExecutable: string;
    mirrorDir: string;
    worktreeDir: string;
    committerName: string;
    committerEmail: string;
  };
  pullRequests: {
    backportBranchTemplate: string;
    prTitleTemplate: string;
    prDescriptionTemplate: string;
    copyReviewersFromOriginal: boolean;
    fixedReviewerIds: string[];
    createPrAsDraft: boolean;
  };
  dashboard: {
    defaultOnlyMine: boolean;
    closedWorkItemStates: string[];
    excludedWorkItemStates: string[];
  };
  engine: { concurrency: number };
  repositories: { name: string; enabled: boolean; defaultBranch: string | null }[];
  releaseBranches: {
    branchName: string;
    versionLabel: string;
    stageLabel: string;
    sortOrder: number;
    enabled: boolean;
  }[];
  updatedAt: string;
}

type Draft = {
  gitExecutable: string;
  mirrorDir: string;
  worktreeDir: string;
  committerName: string;
  committerEmail: string;
  backportBranchTemplate: string;
  prTitleTemplate: string;
  prDescriptionTemplate: string;
  copyReviewersFromOriginal: boolean;
  createPrAsDraft: boolean;
  concurrency: number;
  defaultOnlyMine: boolean;
  closedWorkItemStates: string;
  enabledRepositories: string[];
  enabledReleaseBranches: string[];
};

interface ApiError {
  error: { code: string; message: string; remedy?: string; details?: unknown };
}

function toDraft(data: SettingsResponse): Draft {
  return {
    gitExecutable: data.git.gitExecutable,
    mirrorDir: data.git.mirrorDir,
    worktreeDir: data.git.worktreeDir,
    committerName: data.git.committerName,
    committerEmail: data.git.committerEmail,
    backportBranchTemplate: data.pullRequests.backportBranchTemplate,
    prTitleTemplate: data.pullRequests.prTitleTemplate,
    prDescriptionTemplate: data.pullRequests.prDescriptionTemplate,
    copyReviewersFromOriginal: data.pullRequests.copyReviewersFromOriginal,
    createPrAsDraft: data.pullRequests.createPrAsDraft,
    concurrency: data.engine.concurrency,
    defaultOnlyMine: data.dashboard.defaultOnlyMine,
    closedWorkItemStates: data.dashboard.closedWorkItemStates.join(', '),
    enabledRepositories: data.repositories.filter((r) => r.enabled).map((r) => r.name),
    enabledReleaseBranches: data.releaseBranches.filter((b) => b.enabled).map((b) => b.branchName),
  };
}

export default function SettingsPage() {
  const queryClient = useQueryClient();

  /*
   * `edits` holds only what the user changed. The form value is derived from it
   * plus the server response, so there is no effect copying server state into
   * local state and therefore no cascading render. Setting it back to null
   * discards edits and re-adopts whatever the server last returned.
   */
  const [edits, setEdits] = useState<Draft | null>(null);

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const response = await fetch('/api/settings');
      const body = await response.json();
      if (!response.ok) throw new Error((body as ApiError).error?.message ?? 'Failed to load');
      return body as SettingsResponse;
    },
  });

  const draft: Draft | null = edits ?? (settings.data ? toDraft(settings.data) : null);
  const setDraft = setEdits;

  const save = useMutation({
    mutationFn: async (payload: Draft) => {
      const response = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          closedWorkItemStates: payload.closedWorkItemStates
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        const error = body as ApiError;
        const details = Array.isArray(error.error?.details)
          ? ` (${(error.error.details as { field: string; message: string }[])
            .map((d) => `${d.field}: ${d.message}`)
            .join('; ')})`
          : '';
        throw new Error(`${error.error?.message ?? 'Save failed'}${details}`);
      }
      return body;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      await queryClient.invalidateQueries({ queryKey: ['config'] });
      await queryClient.invalidateQueries({ queryKey: ['matrix'] });
      // Drop local edits so the saved server values become the form value.
      setEdits(null);
    },
  });

  const env = settings.data?.environment;

  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-6">
      <div className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild title="Back to dashboard">
          <Link href="/dashboard">
            <ArrowLeft aria-hidden />
            <span className="sr-only">Back to dashboard</span>
          </Link>
        </Button>
        <div>
          <h1 className="text-base font-semibold tracking-tight">Settings</h1>
          <p className="text-xs text-muted-foreground">
            Release versions, repositories and templates live here, never in source.
          </p>
        </div>
      </div>

      {settings.isLoading || !draft ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {/* --- environment, read-only --- */}
          <Card>
            <CardHeader>
              <CardTitle>Azure DevOps connection</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Read-only. These come from server environment variables, and the Personal Access
                Token is deliberately never sent to the browser. Change them in{' '}
                <code className="rounded bg-surface-sunken px-1 py-0.5">.env.local</code> and
                restart.
              </p>
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <ReadOnly label="Organization" value={env?.adoOrgUrl ?? ''} />
                <ReadOnly label="Project" value={env?.adoProject ?? ''} />
                <ReadOnly label="Signed in as" value={env?.adoUserDisplayName ?? 'unknown'} />
                <ReadOnly
                  label="Personal Access Token"
                  value={env?.patConfigured ? 'configured' : 'missing'}
                  ok={env?.patConfigured}
                />
                <ReadOnly
                  label="CA bundle"
                  value={env?.caBundlePath ?? 'not set'}
                  className="sm:col-span-2"
                />
              </dl>
            </CardContent>
          </Card>

          {/* --- repositories --- */}
          <Card>
            <CardHeader>
              <CardTitle>Repositories</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">
                Unticking a repository removes it from the dashboard without deleting its history.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {settings.data?.repositories.map((repo) => (
                  <CheckboxRow
                    key={repo.name}
                    label={repo.name}
                    hint={repo.defaultBranch ? `default: ${repo.defaultBranch}` : undefined}
                    checked={draft.enabledRepositories.includes(repo.name)}
                    onChange={(checked) =>
                      setDraft({
                        ...draft,
                        enabledRepositories: checked
                          ? [...draft.enabledRepositories, repo.name]
                          : draft.enabledRepositories.filter((name) => name !== repo.name),
                      })
                    }
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          {/* --- release branches --- */}
          <Card>
            <CardHeader>
              <CardTitle>Release columns</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">
                Columns of the tracking matrix, in order. A branch missing from a given repository
                renders as an inert cell rather than outstanding work.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {settings.data?.releaseBranches.map((branch) => (
                  <CheckboxRow
                    key={branch.branchName}
                    label={`${branch.versionLabel} ${branch.stageLabel}`}
                    hint={branch.branchName}
                    checked={draft.enabledReleaseBranches.includes(branch.branchName)}
                    onChange={(checked) =>
                      setDraft({
                        ...draft,
                        enabledReleaseBranches: checked
                          ? [...draft.enabledReleaseBranches, branch.branchName]
                          : draft.enabledReleaseBranches.filter(
                            (name) => name !== branch.branchName,
                          ),
                      })
                    }
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          {/* --- git --- */}
          <Card>
            <CardHeader>
              <CardTitle>Git</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Git executable"
                hint="Absolute path. On this machine `git` on PATH resolves to a zero-byte stub in C:\WINDOWS\system32, so the full path is required."
                className="sm:col-span-2"
              >
                <TextInput
                  value={draft.gitExecutable}
                  onChange={(event) => setDraft({ ...draft, gitExecutable: event.target.value })}
                />
              </Field>
              <Field label="Mirror directory" hint="Bare clones. Roughly 1 GB for all repositories.">
                <TextInput
                  value={draft.mirrorDir}
                  onChange={(event) => setDraft({ ...draft, mirrorDir: event.target.value })}
                />
              </Field>
              <Field label="Worktree directory" hint="Isolated checkout per backport job.">
                <TextInput
                  value={draft.worktreeDir}
                  onChange={(event) => setDraft({ ...draft, worktreeDir: event.target.value })}
                />
              </Field>
              <Field
                label="Committer name"
                hint="Stamped on commits the tool creates. Never inherited from your global git config."
              >
                <TextInput
                  value={draft.committerName}
                  onChange={(event) => setDraft({ ...draft, committerName: event.target.value })}
                />
              </Field>
              <Field label="Committer email">
                <TextInput
                  type="email"
                  value={draft.committerEmail}
                  onChange={(event) => setDraft({ ...draft, committerEmail: event.target.value })}
                />
              </Field>
            </CardContent>
          </Card>

          {/* --- pull requests --- */}
          <Card>
            <CardHeader>
              <CardTitle>Backport pull requests</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field
                label="Branch name template"
                hint="Placeholders: {prId}, {targetSlug}, {targetBranch}. Must start with backport/ — the push guard refuses anything else."
              >
                <TextInput
                  value={draft.backportBranchTemplate}
                  onChange={(event) =>
                    setDraft({ ...draft, backportBranchTemplate: event.target.value })
                  }
                />
              </Field>
              <Field
                label="PR title template"
                hint="Placeholders: {repo}, {targetVersion}, {targetBranch}, {originalTitle}, {prId}."
              >
                <TextInput
                  value={draft.prTitleTemplate}
                  onChange={(event) => setDraft({ ...draft, prTitleTemplate: event.target.value })}
                />
              </Field>
              <Field
                label="PR description template"
                hint="Placeholders: {prId}, {sourceBranch}, {targetBranch}, {pickSha}."
              >
                <TextArea
                  rows={5}
                  value={draft.prDescriptionTemplate}
                  onChange={(event) =>
                    setDraft({ ...draft, prDescriptionTemplate: event.target.value })
                  }
                />
              </Field>
              <CheckboxRow
                label="Copy reviewers from the original pull request"
                hint="Target branches require one non-creator approval, so a backport PR with no reviewer can never complete."
                checked={draft.copyReviewersFromOriginal}
                onChange={(checked) => setDraft({ ...draft, copyReviewersFromOriginal: checked })}
              />
              <CheckboxRow
                label="Create as draft"
                checked={draft.createPrAsDraft}
                onChange={(checked) => setDraft({ ...draft, createPrAsDraft: checked })}
              />
              <p className="text-xs text-muted-foreground">
                Auto-complete is never set. Created pull requests wait for builds and review.
              </p>
            </CardContent>
          </Card>

          {/* --- dashboard + engine --- */}
          <Card>
            <CardHeader>
              <CardTitle>Dashboard and engine</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field
                label="Work item states counted as finished"
                hint='Comma separated. Anything else counts as still open and raises the bug&apos;s category. Observed states: Done, Fixed, Back Merged, Closed Rejected, Confirmed Fixed, Ready to Test.'
              >
                <TextInput
                  value={draft.closedWorkItemStates}
                  onChange={(event) =>
                    setDraft({ ...draft, closedWorkItemStates: event.target.value })
                  }
                />
              </Field>
              <Field
                label="Concurrent backport jobs"
                hint="Each job is a git worktree doing disk I/O. 1 to 16."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={16}
                  value={draft.concurrency}
                  onChange={(event) =>
                    setDraft({ ...draft, concurrency: Number(event.target.value) })
                  }
                  className="max-w-24"
                />
              </Field>
              <CheckboxRow
                label="Default to my pull requests only"
                hint="Off by default: categories order the list instead of hiding rows."
                checked={draft.defaultOnlyMine}
                onChange={(checked) => setDraft({ ...draft, defaultOnlyMine: checked })}
              />
            </CardContent>
          </Card>

          {save.isError ? (
            <div
              className="flex items-start gap-3 rounded-lg border p-3 text-xs"
              style={{
                borderColor: 'color-mix(in oklch, var(--status-failed) 30%, transparent)',
                backgroundColor: 'color-mix(in oklch, var(--status-failed) 8%, transparent)',
              }}
            >
              <AlertCircle
                className="mt-0.5 size-4 shrink-0"
                style={{ color: 'var(--status-failed)' }}
                aria-hidden
              />
              <p className="break-words">{(save.error as Error).message}</p>
            </div>
          ) : null}

          <div className="flex items-center gap-3 pb-6">
            <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>
              {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {save.isPending ? 'Saving…' : 'Save settings'}
            </Button>
            <Button variant="outline" onClick={() => setDraft(null)} disabled={save.isPending}>
              Reset
            </Button>
            {save.isSuccess ? (
              <span
                className="flex items-center gap-1 text-xs"
                style={{ color: 'var(--status-merged)' }}
              >
                <Check className="size-3.5" aria-hidden /> Saved
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function ReadOnly({
  label,
  value,
  ok,
  className,
}: {
  label: string;
  value: string;
  ok?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1.5 break-all text-xs font-medium">
        {ok === true ? (
          <ShieldCheck className="size-3.5 shrink-0" style={{ color: 'var(--status-merged)' }} aria-hidden />
        ) : null}
        <span style={ok === false ? { color: 'var(--status-failed)' } : undefined}>{value}</span>
      </dd>
    </div>
  );
}
