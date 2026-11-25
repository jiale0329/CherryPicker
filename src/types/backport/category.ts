/**
 * Row categories for the dashboard.
 *
 * Categories order the matrix instead of filtering it. Every fix across every
 * tracked repository is always listed; the category decides how high it sits
 * and how it is labelled. This keeps "my open bugs" immediately visible without
 * hiding the 27 fixes that are marked Done yet still missing backports.
 */

export const ROW_CATEGORIES = [
  'MINE_OPEN',
  'MINE_CLOSED',
  'OTHERS_OPEN',
  'OTHERS_CLOSED',
] as const;

export type RowCategory = (typeof ROW_CATEGORIES)[number];

export interface CategoryDescriptor {
  readonly category: RowCategory;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  /** Lower sorts first. */
  readonly priority: number;
  readonly colorVar: string;
}

export const CATEGORY_DESCRIPTORS: Record<RowCategory, CategoryDescriptor> = {
  MINE_OPEN: {
    category: 'MINE_OPEN',
    label: 'My open bugs',
    shortLabel: 'Mine · open',
    description:
      'You created the pull request and the work item is not finished. Most likely to need a backport from you.',
    priority: 0,
    colorVar: 'status-conflict',
  },
  MINE_CLOSED: {
    category: 'MINE_CLOSED',
    label: 'My finished bugs',
    shortLabel: 'Mine · done',
    description: 'You created the pull request and the work item is finished.',
    priority: 1,
    colorVar: 'status-pr-created',
  },
  OTHERS_OPEN: {
    category: 'OTHERS_OPEN',
    label: 'Other open bugs',
    shortLabel: 'Others · open',
    description: 'Created by someone else, work item not finished.',
    priority: 2,
    colorVar: 'status-cherry-picked',
  },
  OTHERS_CLOSED: {
    category: 'OTHERS_CLOSED',
    label: 'Other finished bugs',
    shortLabel: 'Others · done',
    description: 'Created by someone else, work item finished.',
    priority: 3,
    colorVar: 'status-not-started',
  },
};

export function describeCategory(category: RowCategory): CategoryDescriptor {
  return CATEGORY_DESCRIPTORS[category];
}

export function categoriseRow(input: {
  isMine: boolean;
  isWorkItemOpen: boolean;
}): RowCategory {
  if (input.isMine) return input.isWorkItemOpen ? 'MINE_OPEN' : 'MINE_CLOSED';
  return input.isWorkItemOpen ? 'OTHERS_OPEN' : 'OTHERS_CLOSED';
}

export function isRowCategory(value: string): value is RowCategory {
  return (ROW_CATEGORIES as readonly string[]).includes(value);
}

/**
 * A work item with no cached state is treated as open. An unresolved state is
 * not evidence that the bug is finished, and treating it as closed would push
 * real work to the bottom of the list.
 */
export function isWorkItemOpen(
  state: string | null,
  closedStates: ReadonlySet<string>,
): boolean {
  if (state === null) return true;
  return !closedStates.has(state);
}
