/**
 * Small display formatters.
 *
 * Kept separate from components so they can be tested without rendering.
 */

/**
 * Human-readable age, e.g. "just now", "4 min ago", "yesterday".
 *
 * A full locale timestamp answers "when exactly", which is rarely the question.
 * What matters on this dashboard is whether the data is fresh enough to trust,
 * and relative time answers that at a glance.
 */
export function relativeTime(value: string | Date | null | undefined, now = new Date()): string {
  if (!value) return 'never';

  const then = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(then.getTime())) return 'unknown';

  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;

  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;

  return `${Math.round(months / 12)} yr ago`;
}

/** Pluralise without a library: `count(1, 'bug')` -> "1 bug". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Groups release columns by version so the header can show three version
 * groups instead of six flat columns.
 *
 * Relies on the configured sort order already placing a version's stages
 * together, which is what makes a two-row header line up with the body.
 */
export function groupColumnsByVersion<T extends { versionLabel: string; stageLabel: string }>(
  columns: readonly T[],
): { versionLabel: string; stages: T[] }[] {
  const groups: { versionLabel: string; stages: T[] }[] = [];

  for (const column of columns) {
    const last = groups.at(-1);
    if (last && last.versionLabel === column.versionLabel) last.stages.push(column);
    else groups.push({ versionLabel: column.versionLabel, stages: [column] });
  }

  return groups;
}
