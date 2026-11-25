'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, EyeOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { BackportDialog } from '@/components/backport/backport-dialog';
import { DetailDrawer, type DrawerTarget } from '@/components/backport/detail-drawer';
import { CellLegend } from '@/components/dashboard/cell-mark';
import { DashboardToolbar, type MatrixScope } from '@/components/dashboard/toolbar';

import { ReleaseMatrix } from '@/components/dashboard/release-matrix';
import { SummaryCards } from '@/components/dashboard/summary-cards';
import { AppHeader, type RefreshMode } from '@/components/layout/app-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  MatrixBugRow,
  MatrixCell,
  MatrixFix,
  MatrixResult,
} from '@/services/backport/matrix';
import type { RowCategory } from '@/types/backport/category';

const PAGE_SIZE = 25;

interface ConfigResponse {
  identity: { id: string; displayName: string } | null;
  defaultOnlyMine: boolean;
  excludedWorkItemStates: string[];
  adoOrgUrl: string | null;
  adoProject: string | null;
}

interface SyncResponse {
  repositories: number;
  pullRequests: number;
  workItems: number;
  errors: { repository: string; branch: string; message: string }[];
}

interface ApiError {
  error: { code: string; message: string; remedy?: string };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok) {
    const message = (body as ApiError).error?.message ?? 'Request failed';
    const remedy = (body as ApiError).error?.remedy;
    throw new Error(remedy ? `${message} ${remedy}` : message);
  }
  return body as T;
}

export default function DashboardPage() {
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedBugs, setSelectedBugs] = useState<Set<string>>(new Set());
  const [expandedBugs, setExpandedBugs] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<RowCategory | null>(null);
  const [onlyOutstanding, setOnlyOutstanding] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [scope, setScope] = useState<MatrixScope>('watchlist');
  const [drawerTarget, setDrawerTarget] = useState<DrawerTarget | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /*
   * Keyboard shortcuts.
   *
   * `/` focuses search and Escape closes whatever is open. Guarded against
   * firing while the user is typing, so `/` in the search box or the add-bug
   * field is just a character.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;

      if (event.key === 'Escape') {
        setDrawerTarget(null);
        setDialogOpen(false);
        return;
      }

      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const config = useQuery({
    queryKey: ['config'],
    queryFn: () => getJson<ConfigResponse>('/api/config'),
    staleTime: Infinity,
  });

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const matrix = useQuery({
    queryKey: ['matrix', search, page, category, onlyOutstanding, scope] as const,
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        scope,
      });
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      if (onlyOutstanding) params.set('outstanding', 'true');
      return getJson<MatrixResult>(`/api/matrix?${params.toString()}`);
    },
    enabled: !config.isLoading,
  });

  const unwatch = useMutation({
    mutationFn: async (workItemId: number) => {
      const response = await fetch(`/api/watchlist?workItemId=${workItemId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error((body as ApiError).error?.message ?? 'Could not remove the bug');
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['matrix'] });
    },
  });

  const [refreshMode, setRefreshMode] = useState<RefreshMode | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const sync = useMutation({
    mutationFn: async (mode: RefreshMode) => {
      setRefreshMode(mode);
      setStartedAt(Date.now());
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error((body as ApiError).error?.message ?? 'Sync failed');
      return body as SyncResponse;
    },
    onSettled: () => {
      setRefreshMode(null);
      void queryClient.invalidateQueries({ queryKey: ['matrix'] });
    },
  });

  /*
   * Elapsed counter for the slow path, so a full sync never looks hung.
   *
   * The start time is recorded by the mutation, not reset here: writing state
   * synchronously inside an effect body causes a cascading render, which is
   * what React's set-state-in-effect rule is pointing at. Only the interval
   * callback writes, and that is asynchronous.
   */
  useEffect(() => {
    if (!sync.isPending || refreshMode !== 'full' || startedAt === null) return;

    const tick = () => setElapsed(Math.round((Date.now() - startedAt) / 1000));
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [sync.isPending, refreshMode, startedAt]);

  const totalPages = useMemo(
    () => (matrix.data ? Math.max(1, Math.ceil(matrix.data.totalRows / PAGE_SIZE)) : 1),
    [matrix.data],
  );

  const toggleBug = (key: string) => {
    setSelectedBugs((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelectedBugs((current) => {
      const next = new Set(current);
      for (const row of matrix.data?.rows ?? []) {
        if (checked) next.add(row.key);
        else next.delete(row.key);
      }
      return next;
    });
  };

  const toggleExpand = (key: string) => {
    setExpandedBugs((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openCell = (bug: MatrixBugRow, fix: MatrixFix, cell: MatrixCell) => {
    setDrawerTarget({ bug, fix, cell });
  };

  const clearFilters = () => {
    setCategory(null);
    setOnlyOutstanding(false);
    setSearchInput('');
    setPage(1);
  };

  return (
    <div className="flex min-h-full flex-col">
      <AppHeader
        onRefresh={(mode) => sync.mutate(mode)}
        isRefreshing={sync.isPending}
        refreshMode={refreshMode}
        elapsedSeconds={sync.isPending ? elapsed : undefined}
      />

      <main className="flex-1 space-y-4 px-5 py-5">
        <DashboardToolbar
          scope={scope}
          onScopeChange={(next) => {
            setScope(next);
            setPage(1);
            setCategory(null);
          }}
          search={searchInput}
          onSearchChange={setSearchInput}
          onlyOutstanding={onlyOutstanding}
          onOnlyOutstandingChange={(value) => {
            setOnlyOutstanding(value);
            setPage(1);
          }}
          category={category}
          onCategoryChange={(next) => {
            setCategory(next);
            setPage(1);
          }}
          matrix={matrix.data}
          selectedCount={selectedBugs.size}
          onClearSelection={() => setSelectedBugs(new Set())}
          onCreateBackports={() => setDialogOpen(true)}
          searchRef={searchRef}
        />

        {/* Five cards earn their space when triaging everything, not above a
            short watchlist. */}
        <SummaryCards
          summary={matrix.data?.summary}
          isLoading={matrix.isLoading}
          variant={scope === 'watchlist' ? 'inline' : 'cards'}
        />

        {matrix.isError ? (
          <ErrorPanel message={(matrix.error as Error).message} onRetry={() => matrix.refetch()} />
        ) : null}

        {sync.isError ? (
          <ErrorPanel message={(sync.error as Error).message} onRetry={() => sync.mutate(refreshMode ?? 'watchlist')} />
        ) : null}

        {sync.data && sync.data.errors.length > 0 ? (
          <ErrorPanel
            message={sync.data.errors
              .map((error) => `${error.repository} ${error.branch}: ${error.message}`)
              .join(' · ')}
            onRetry={() => sync.mutate(refreshMode ?? 'watchlist')}
          />
        ) : null}

        {matrix.isLoading || config.isLoading ? (
          <div className="space-y-2 rounded-lg border border-border bg-card p-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : null}

        {matrix.data && matrix.data.filtered.hiddenRows > 0 ? (
          <FilterNotice
            hiddenRows={matrix.data.filtered.hiddenRows}
            hiddenMissing={matrix.data.filtered.hiddenMissingBackports}
            onClear={clearFilters}
          />
        ) : null}

        {matrix.data ? (
          <>
            <ReleaseMatrix
              matrix={matrix.data}
              selectedBugs={selectedBugs}
              expandedBugs={expandedBugs}
              onToggleBug={toggleBug}
              onToggleAll={toggleAll}
              onToggleExpand={toggleExpand}
              onOpenCell={openCell}
              onUnwatch={(workItemId) => unwatch.mutate(workItemId)}
            />

            {/* One legend, since the grid marks carry meaning by colour. */}
            <CellLegend />

            {totalPages > 1 ? (
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Page <span className="tabular">{page}</span> of{' '}
                  <span className="tabular">{totalPages}</span>
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage((current) => current - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= totalPages}
                    onClick={() => setPage((current) => current + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </main>

      {drawerTarget ? (
        <DetailDrawer
          target={drawerTarget}
          orgUrl={config.data?.adoOrgUrl}
          project={config.data?.adoProject}
          onClose={() => setDrawerTarget(null)}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: ['matrix'] });
          }}
        />
      ) : null}

      {dialogOpen && matrix.data ? (
        <BackportDialog
          matrix={matrix.data}
          selected={selectedBugs}
          onClose={() => setDialogOpen(false)}
          onCompleted={() => {
            // Re-read from ADO so cells reflect the new pull requests.
            void queryClient.invalidateQueries({ queryKey: ['matrix'] });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Filters here can hide genuinely outstanding backports, so what is hidden is
 * always reported. Measured on real data: hiding work items that are Done
 * concealed 27 fixes still missing 70 backports between them.
 */
function FilterNotice({
  hiddenRows,
  hiddenMissing,
  onClear,
}: {
  hiddenRows: number;
  hiddenMissing: number;
  onClear: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-4 py-2.5 text-xs"
      style={{
        borderColor: 'color-mix(in oklch, var(--status-conflict) 30%, transparent)',
        backgroundColor: 'color-mix(in oklch, var(--status-conflict) 8%, transparent)',
      }}
    >
      <EyeOff
        className="size-3.5 shrink-0"
        style={{ color: 'var(--status-conflict)' }}
        aria-hidden
      />
      <span>
        <span className="tabular font-medium">{hiddenRows}</span> fix
        {hiddenRows === 1 ? '' : 'es'} hidden by filters
        {hiddenMissing > 0 ? (
          <>
            , between them still missing{' '}
            <span className="tabular font-medium">{hiddenMissing}</span> backport
            {hiddenMissing === 1 ? '' : 's'}
          </>
        ) : null}
        .
      </span>
      <Button size="sm" variant="outline" className="ml-auto" onClick={onClear}>
        Show all
      </Button>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border p-4"
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
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Could not load data</p>
        <p className="mt-0.5 break-words text-xs text-muted-foreground">{message}</p>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}