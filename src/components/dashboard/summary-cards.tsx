import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { MatrixSummary } from '@/services/backport/matrix';

/**
 * Summary, in one of two densities.
 *
 * Labels are short and unexplained on purpose. Each card previously carried a
 * sentence of hint text beneath the number ("Completed pull requests on the
 * selected source branch"), which turned a five-number summary into five
 * paragraphs. The precise definitions live in the docs and the detail drawer;
 * the summary only needs to be scannable.
 */

interface CardSpec {
  key: keyof MatrixSummary;
  label: string;
  colorVar: string;
  /** Tooltip, for the definition that used to be printed on screen. */
  title: string;
}

const CARDS: CardSpec[] = [
  {
    key: 'totalFixes',
    label: 'Bugs',
    colorVar: 'foreground',
    title: 'Bug items in the current view',
  },
  {
    key: 'fullyBackported',
    label: 'Backported',
    colorVar: 'status-merged',
    title: 'Merged into every expected release, in every repository fixing the bug',
  },
  {
    key: 'outstanding',
    label: 'Outstanding',
    colorVar: 'status-conflict',
    title: 'At least one expected release is still missing the fix',
  },
  {
    key: 'awaitingPrApproval',
    label: 'In review',
    colorVar: 'status-pr-created',
    title: 'A backport pull request is open, waiting on builds or review',
  },
  {
    key: 'failedOrConflicted',
    label: 'Blocked',
    colorVar: 'status-failed',
    title: 'Conflicted or failed, needs manual attention',
  },
];

export function SummaryCards({
  summary,
  isLoading,
  variant = 'cards',
}: {
  summary?: MatrixSummary;
  isLoading: boolean;
  variant?: 'cards' | 'inline';
}) {
  if (variant === 'inline') {
    if (isLoading) return <Skeleton className="h-5 w-64" />;
    if (!summary) return null;

    return (
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {CARDS.filter((spec) => spec.key === 'totalFixes' || summary[spec.key] > 0).map((spec) => (
          <span key={spec.key} className="inline-flex items-baseline gap-1.5" title={spec.title}>
            <span
              className="tabular text-base font-semibold"
              style={{ color: `var(--${spec.colorVar})` }}
            >
              {summary[spec.key]}
            </span>
            <span className="text-xs text-muted-foreground">{spec.label}</span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {CARDS.map((spec) => (
        <Card key={spec.key} title={spec.title}>
          <CardContent className="p-4">
            {isLoading ? (
              <Skeleton className="h-7 w-12" />
            ) : (
              <p
                className="tabular text-2xl font-semibold leading-none"
                style={{ color: `var(--${spec.colorVar})` }}
              >
                {summary?.[spec.key] ?? 0}
              </p>
            )}
            <p className="mt-1.5 text-xs text-muted-foreground">{spec.label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
