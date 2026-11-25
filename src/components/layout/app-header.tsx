'use client';

import { useQuery } from '@tanstack/react-query';
import { GitBranch, Loader2, RefreshCw, Settings, ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
}

interface HealthResponse {
  ok: boolean;
  organization: string | null;
  project: string | null;
  identity: { displayName: string } | null;
  checks: HealthCheck[];
}

export type RefreshMode = 'watchlist' | 'full';

export function AppHeader({
  onRefresh,
  isRefreshing,
  refreshMode,
  elapsedSeconds,
}: {
  onRefresh: (mode: RefreshMode) => void;
  isRefreshing: boolean;
  refreshMode?: RefreshMode | null;
  /** Elapsed time of a running full sync, so it cannot look hung. */
  elapsedSeconds?: number;
}) {
  const health = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: async () => {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error('Health check failed');
      return response.json();
    },
    refetchInterval: 120_000,
  });

  const failing = health.data?.checks.filter((check) => !check.ok) ?? [];

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface-base/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary/15">
            <GitBranch className="size-4 text-primary" aria-hidden />
          </div>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight">Release Backport Manager</h1>
            <p className="text-xs text-muted-foreground">
              {/* Project only. The repository count was noise: it never
                  changes during a session and is listed in settings. */}
              {health.data?.project ? (
                <span className="tabular">{health.data.project}</span>
              ) : (
                'Connecting…'
              )}
            </p>
          </div>
        </div>

        <ConnectionBadge
          isLoading={health.isLoading}
          ok={health.data?.ok ?? false}
          identity={health.data?.identity?.displayName}
          failing={failing}
        />

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/*
            Two refresh actions rather than one, because they differ by an order
            of magnitude. The watchlist re-fetch is seconds; the full sync reads
            every tracked repository and takes about a minute. A single button
            that sometimes took 60 seconds with no feedback just felt hung.
          */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRefresh('watchlist')}
            disabled={isRefreshing}
            title="Re-fetch the bugs on your watchlist from their work items. Takes seconds."
          >
            <RefreshCw
              className={cn(isRefreshing && refreshMode === 'watchlist' && 'animate-spin')}
              aria-hidden
            />
            {isRefreshing && refreshMode === 'watchlist' ? 'Refreshing…' : 'Refresh'}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRefresh('full')}
            disabled={isRefreshing}
            title="Re-read completed pull requests from every tracked repository. Takes about a minute."
          >
            {isRefreshing && refreshMode === 'full' ? (
              <>
                <Loader2 className="animate-spin" aria-hidden />
                Full sync{elapsedSeconds !== undefined ? ` ${elapsedSeconds}s` : ''}…
              </>
            ) : (
              'Full sync'
            )}
          </Button>

          <Button variant="ghost" size="icon" asChild title="Settings">
            <Link href="/settings">
              <Settings aria-hidden />
              <span className="sr-only">Settings</span>
            </Link>
          </Button>
        </div>
      </div>

      {failing.length > 0 ? (
        <div
          className="flex flex-wrap items-start gap-2 border-t px-5 py-2 text-xs"
          style={{
            borderColor: 'color-mix(in oklch, var(--status-failed) 30%, transparent)',
            backgroundColor: 'color-mix(in oklch, var(--status-failed) 10%, transparent)',
          }}
        >
          <ShieldAlert
            className="mt-0.5 size-3.5 shrink-0"
            style={{ color: 'var(--status-failed)' }}
            aria-hidden
          />
          <div className="space-y-0.5">
            {failing.map((check) => (
              <p key={check.name}>
                <span className="font-medium">{check.name}:</span> {check.detail}
                {check.remedy ? (
                  <span className="text-muted-foreground"> — {check.remedy}</span>
                ) : null}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </header>
  );
}

function ConnectionBadge({
  isLoading,
  ok,
  identity,
  failing,
}: {
  isLoading: boolean;
  ok: boolean;
  identity?: string;
  failing: HealthCheck[];
}) {
  const colorVar = isLoading ? 'status-not-started' : ok ? 'status-merged' : 'status-failed';
  const label = isLoading
    ? 'Checking…'
    : ok
      ? (identity ?? 'Connected')
      : `${failing.length} issue${failing.length === 1 ? '' : 's'}`;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium"
      style={{
        color: `var(--${colorVar})`,
        borderColor: `color-mix(in oklch, var(--${colorVar}) 35%, transparent)`,
        backgroundColor: `color-mix(in oklch, var(--${colorVar}) 12%, transparent)`,
      }}
    >
      {ok ? (
        <ShieldCheck className="size-3.5" aria-hidden />
      ) : (
        <ShieldAlert className="size-3.5" aria-hidden />
      )}
      {label}
    </span>
  );
}
