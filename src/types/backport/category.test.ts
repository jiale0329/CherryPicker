import { describe, expect, it } from 'vitest';

import { categoriseRow, describeCategory, isWorkItemOpen, ROW_CATEGORIES } from './category';

/**
 * States observed in jblprd/jemsmm: Done, Fixed, Back Merged, Closed Rejected,
 * Confirmed Fixed, Ready to Test. "Closed Rejected" counts as finished because
 * a rejected bug should not be backported.
 */
const CLOSED = new Set(['Done', 'Closed Rejected']);

describe('isWorkItemOpen', () => {
  it.each(['Fixed', 'Confirmed Fixed', 'Ready to Test', 'Back Merged'])(
    'treats %s as still open',
    (state) => {
      expect(isWorkItemOpen(state, CLOSED)).toBe(true);
    },
  );

  it.each(['Done', 'Closed Rejected'])('treats %s as finished', (state) => {
    expect(isWorkItemOpen(state, CLOSED)).toBe(false);
  });

  it('treats an unknown state as open rather than finished', () => {
    // An unresolved work item is not evidence the bug is done. Guessing
    // "closed" would push real work to the bottom of the list.
    expect(isWorkItemOpen(null, CLOSED)).toBe(true);
  });
});

describe('categoriseRow', () => {
  it('puts my open bugs in the highest priority category', () => {
    expect(categoriseRow({ isMine: true, isWorkItemOpen: true })).toBe('MINE_OPEN');
  });

  it('separates my finished bugs from my open ones', () => {
    expect(categoriseRow({ isMine: true, isWorkItemOpen: false })).toBe('MINE_CLOSED');
  });

  it('categorises other people\u2019s work separately', () => {
    expect(categoriseRow({ isMine: false, isWorkItemOpen: true })).toBe('OTHERS_OPEN');
    expect(categoriseRow({ isMine: false, isWorkItemOpen: false })).toBe('OTHERS_CLOSED');
  });

  it('orders my open bugs before everything else', () => {
    const priorities = ROW_CATEGORIES.map((category) => describeCategory(category).priority);
    expect(describeCategory('MINE_OPEN').priority).toBe(Math.min(...priorities));
  });

  it('gives every category a distinct priority so sorting is stable', () => {
    const priorities = ROW_CATEGORIES.map((category) => describeCategory(category).priority);
    expect(new Set(priorities).size).toBe(ROW_CATEGORIES.length);
  });

  it('describes every category', () => {
    for (const category of ROW_CATEGORIES) {
      const descriptor = describeCategory(category);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.description.length).toBeGreaterThan(0);
      expect(descriptor.colorVar).toMatch(/^status-/);
    }
  });
});
