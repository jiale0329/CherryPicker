import { AlertTriangle, Check, CircleDashed, GitPullRequest, Loader2, Minus, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { MatrixCellStatus } from '@/types/backport/status';
import { describeStatus } from '@/types/backport/status';

/**
 * Status indicator.
 *
 * The colour comes from a CSS variable applied inline rather than a Tailwind
 * class. Tailwind v4 scans source text for class names, so a class assembled at
 * runtime (`bg-${colorVar}`) would never be emitted. Inline custom properties
 * keep globals.css as the single definition of the status ramp.
 */

const ICONS: Record<MatrixCellStatus, typeof Check> = {
  NOT_STARTED: CircleDashed,
  PROCESSING: Loader2,
  CHERRY_PICKED: GitPullRequest,
  PR_CREATED: GitPullRequest,
  PR_APPROVED: Check,
  MERGED: Check,
  CONFLICT: AlertTriangle,
  FAILED: X,
  SKIPPED: Minus,
  UNAVAILABLE: Minus,
};

export function StatusPill({
  status,
  className,
  showLabel = true,
}: {
  status: MatrixCellStatus;
  className?: string;
  showLabel?: boolean;
}) {
  const descriptor = describeStatus(status);
  const Icon = ICONS[status];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
        'border tabular',
        className,
      )}
      style={{
        color: `var(--${descriptor.colorVar})`,
        borderColor: `color-mix(in oklch, var(--${descriptor.colorVar}) 35%, transparent)`,
        backgroundColor: `color-mix(in oklch, var(--${descriptor.colorVar}) 12%, transparent)`,
      }}
      title={descriptor.description}
    >
      <Icon className={cn('size-3.5', status === 'PROCESSING' && 'animate-spin')} aria-hidden />
      {showLabel ? descriptor.label : null}
    </span>
  );
}
