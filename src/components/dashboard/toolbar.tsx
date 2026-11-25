'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2, Plus, Search } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { MatrixResult } from '@/services/backport/matrix';
import type { RowCategory } from '@/types/backport/category';

/**
 * One control row for the whole dashboard.
 *
 * This replaces three stacked strips - scope tabs plus add-bug, category chips,
 * and a separate filter row. Each was defensible alone; together they were more
 * chrome than the seven-row table beneath them.
 *
 * Two things deliberately stay visible rather than being tidied away: the size
 * of the other scope, and how many rows the filters are hiding. Those are the
 * numbers that stop the dashboard quietly under-reporting work.
 */

export type MatrixScope = 'watchlist' | 'all';

interface AddResponse {
  entry: { workItemId: number; title: string | null };
  fetch: { linked: number; cached: number; skippedUntrackedRepos: number };
  alreadyWatched: boolean;
}

export interface ToolbarProps {
  scope: MatrixScope;
  onScopeChange: (scope: MatrixScope) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onlyOutstanding: boolean;
  onOnlyOutstandingChange: (value: boolean) => void;
  category: RowCategory | null;
  onCategoryChange: (category: RowCategory | null) => void;
  matrix?: MatrixResult;
  selectedCount: number;
  onClearSelection: () => void;
  onCreateBackports: () => void;
  searchRef?: React.RefObject<HTMLInputElement | null>;
}

export function DashboardToolbar(props: ToolbarProps) {
  const queryClient = useQueryClient();
  const [bugInput, setBugInput] = useState('');
  const [added, setAdded] = useState<AddResponse | null>(null);
  const fallbackRef = useRef<HTMLInputElement>(null);
  const searchRef = props.searchRef ?? fallbackRef;

  const add = useMutation({
    mutationFn: async (workItemId: string) => {
      const response = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workItemId }),
      });
      const payload = await response.json();
      if (!response.ok) {
        const message = payload?.error?.message ?? 'Could not add the bug';
        throw new Error(payload?.error?.remedy ? `${message} ${payload.error.remedy}` : message);
      }
      return payload as AddResponse;
    },
    onSuccess: async (payload) => {
      setAdded(payload);
      setBugInput('');
      await queryClient.invalidateQueries({ queryKey: ['matrix'] });
    },
  });

  // Both tab counts come from here, which is why the paragraph that used to
  // restate "N bugs are not on your watchlist" was removed: the tab says it.
  const scopeData = props.matrix?.scope;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* scope */}
        <div className="inline-flex rounded-md border border-border p-0.5" role="tablist">
          <ScopeTab
            label="Watchlist"
            count={scopeData?.watchedRows}
            isActive={props.scope === 'watchlist'}
            onClick={() => props.onScopeChange('watchlist')}
            hint="Bugs you pinned, refreshed from the work item itself."
          />
          <ScopeTab
            label="All bugs"
            count={scopeData?.allRows}
            isActive={props.scope === 'all'}
            onClick={() => props.onScopeChange('all')}
            hint="Every bug found by the full sync, including ones nobody pinned."
          />
        </div>

        {/* search */}
        <div className="relative min-w-52 flex-1 max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={searchRef}
            value={props.search}
            onChange={(event) => props.onSearchChange(event.target.value)}
            placeholder="Search…  (/)"
            aria-label="Search bugs, pull requests, commits or repositories"
            className="h-8 w-full rounded-md border border-border-strong bg-surface-raised pl-7.5 pr-2 text-xs outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/60"
          />
        </div>

        {/* needs action */}
        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
          title="Show only bugs with at least one expected backport still missing"
        >
          <input
            type="checkbox"
            checked={props.onlyOutstanding}
            onChange={(event) => props.onOnlyOutstandingChange(event.target.checked)}
            className="size-3.5 cursor-pointer accent-primary"
          />
          Needs action
        </label>

        {/* category, only useful when triaging the full set */}
        {props.scope === 'all' && props.matrix ? (
          <select
            value={props.category ?? ''}
            onChange={(event) =>
              props.onCategoryChange((event.target.value || null) as RowCategory | null)
            }
            aria-label="Filter by category"
            className="h-8 rounded-md border border-border-strong bg-surface-raised px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <option value="">Everyone</option>
            {props.matrix.categories
              .filter((item) => item.rows > 0)
              .map((item) => (
                <option key={item.category} value={item.category}>
                  {item.shortLabel} ({item.rows})
                </option>
              ))}
          </select>
        ) : null}

        {/* add bug */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = bugInput.trim();
            if (value) add.mutate(value);
          }}
          className="flex items-center gap-1.5"
        >
          <input
            value={bugInput}
            onChange={(event) => setBugInput(event.target.value)}
            placeholder="Add bug #…"
            inputMode="numeric"
            aria-label="Add bug by work item number"
            className="h-8 w-32 rounded-md border border-border-strong bg-surface-raised px-2 text-xs outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/60"
          />
          <Button
            type="submit"
            size="icon"
            variant="outline"
            className="size-8"
            disabled={!bugInput.trim() || add.isPending}
            title="Pin this bug and fetch its pull requests"
          >
            {add.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
            <span className="sr-only">Add bug</span>
          </Button>
        </form>

        {/* Freshness only. The row count is already on the active scope tab. */}
        {props.matrix ? (
          <p className="text-xs text-muted-foreground" title="Last read from Azure DevOps">
            {relativeTime(props.matrix.lastSyncedAt)}
          </p>
        ) : null}

        {/* selection actions */}
        {props.selectedCount > 0 ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              <span className="tabular">{props.selectedCount}</span> selected
            </span>
            <Button size="sm" variant="outline" onClick={props.onClearSelection}>
              Clear
            </Button>
            <Button size="sm" onClick={props.onCreateBackports}>
              Create Backport PRs
            </Button>
          </div>
        ) : null}
      </div>

      {add.isError ? (
        <Notice tone="status-failed" icon={<AlertCircle className="size-3.5" aria-hidden />}>
          {(add.error as Error).message}
        </Notice>
      ) : null}

      {/*
        Only surfaced when there is nothing to show for the bug, which is the
        case worth a sentence. A successful pin needs no narration: the row
        appears in the table and the tab count goes up.
      */}
      {added && added.fetch.cached === 0 ? (
        <Notice tone="status-conflict" icon={<AlertCircle className="size-3.5" aria-hidden />}>
          <span className="tabular font-medium">#{added.entry.workItemId}</span> has no pull
          requests in the tracked repositories yet.
        </Notice>
      ) : null}

      {/* What the filters are hiding, kept because a filter must never conceal work. */}
      {props.matrix && props.matrix.filtered.hiddenRows > 0 ? (
        <p className="text-xs text-muted-foreground">
          <span className="tabular">{props.matrix.filtered.hiddenRows}</span> hidden
          {props.matrix.filtered.hiddenMissingBackports > 0 ? (
            <>
              {' · '}
              <span className="tabular">{props.matrix.filtered.hiddenMissingBackports}</span>{' '}
              backports missing
            </>
          ) : null}
          {' · '}
          <button
            type="button"
            onClick={() => {
              props.onCategoryChange(null);
              props.onOnlyOutstandingChange(false);
              props.onSearchChange('');
            }}
            className="cursor-pointer text-foreground underline decoration-border hover:decoration-foreground"
          >
            clear filters
          </button>
        </p>
      ) : null}
    </div>
  );
}

function ScopeTab({
  label,
  count: rows,
  isActive,
  onClick,
  hint,
}: {
  label: string;
  count?: number;
  isActive: boolean;
  onClick: () => void;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      title={hint}
      onClick={onClick}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        isActive
          ? 'bg-accent font-medium text-accent-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      {rows !== undefined ? <span className="tabular opacity-70">{rows}</span> : null}
    </button>
  );
}

function Notice({
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
      className="flex items-start gap-2 rounded-md border px-3 py-1.5 text-xs"
      style={{
        borderColor: `color-mix(in oklch, var(--${tone}) 28%, transparent)`,
        backgroundColor: `color-mix(in oklch, var(--${tone}) 7%, transparent)`,
      }}
    >
      <span style={{ color: `var(--${tone})` }} className="mt-0.5 shrink-0">
        {icon}
      </span>
      <p className="break-words">{children}</p>
    </div>
  );
}
