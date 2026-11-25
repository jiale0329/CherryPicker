import { AlertTriangle, Check, Loader2, Minus } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  describeStatus,
  gridTone,
  GRID_TONE_COLOR,
  type MatrixCellStatus,
} from '@/types/backport/status';

/**
 * A single matrix cell mark.
 *
 * Deliberately small. The previous version rendered a bordered pill with an
 * icon and optional pull request number in every cell, which at six columns a
 * row dominated the table. Here colour carries the meaning, the exact status
 * lives in the tooltip, and the detail drawer holds everything else.
 */
export function CellMark({
  status,
  isOrigin,
  needsReview,
  title,
  className,
}: {
  status: MatrixCellStatus;
  isOrigin?: boolean;
  /** Something equivalent was found but is not proof. */
  needsReview?: boolean;
  title?: string;
  className?: string;
}) {
  const descriptor = describeStatus(status);
  const tone = gridTone(status);
  const color = `var(--${GRID_TONE_COLOR[tone]})`;
  const label = title ?? `${descriptor.label} — ${descriptor.description}`;

  if (status === 'UNAVAILABLE') {
    return (
      <span
        className={cn('inline-flex size-5 items-center justify-center', className)}
        title={label}
        aria-label={descriptor.label}
      >
        <Minus className="size-3 text-muted-foreground/40" aria-hidden />
      </span>
    );
  }

  // The origin is where the fix came from, so it reads as context rather than
  // as an achievement to count.
  if (isOrigin) {
    return (
      <span
        className={cn('inline-flex size-5 items-center justify-center', className)}
        title={label}
        aria-label="Origin of this fix"
      >
        <span
          className="size-2 rounded-full ring-1"
          style={{ backgroundColor: 'transparent', color, boxShadow: `inset 0 0 0 1px ${color}` }}
        />
      </span>
    );
  }

  return (
    <span
      className={cn('relative inline-flex size-5 items-center justify-center', className)}
      title={label}
      aria-label={descriptor.label}
    >
      {tone === 'done' ? (
        <Check className="size-4" strokeWidth={2.75} style={{ color }} aria-hidden />
      ) : tone === 'progress' ? (
        status === 'PROCESSING' ? (
          <Loader2 className="size-4 animate-spin" style={{ color }} aria-hidden />
        ) : (
          <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
        )
      ) : status === 'CONFLICT' || status === 'FAILED' ? (
        <AlertTriangle className="size-4" strokeWidth={2.5} style={{ color }} aria-hidden />
      ) : (
        // Not started: an open ring, so an empty cell still reads as "to do"
        // rather than as missing data. Thicker than before, which was close to
        // invisible against the raised surface.
        <span
          className="size-2.5 rounded-full"
          style={{ boxShadow: `inset 0 0 0 2px color-mix(in oklch, ${color} 75%, transparent)` }}
        />
      )}

      {needsReview ? (
        <span
          className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full"
          style={{ backgroundColor: 'var(--status-conflict)' }}
          title="A similar patch was found on this branch. Review before backporting."
        />
      ) : null}
    </span>
  );
}

/**
 * Legend for the marks, shown once beneath the table.
 *
 * Kept because the grid is iconographic, but quiet: small, muted, and without
 * the "Not applicable" entry, whose faint dash explains itself and which only
 * added a sixth item to scan past.
 */
export function CellLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground/80',
        className,
      )}
    >
      <LegendItem status="MERGED" label="Merged" />
      <LegendItem status="PR_CREATED" label="In progress" />
      <LegendItem status="NOT_STARTED" label="Needs action" />
      <LegendItem status="CONFLICT" label="Blocked" />
      <span className="flex items-center gap-1.5">
        <CellMark status="MERGED" isOrigin title="Origin" />
        Origin
      </span>
    </div>
  );
}

function LegendItem({ status, label }: { status: MatrixCellStatus; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <CellMark status={status} title={label} />
      {label}
    </span>
  );
}
