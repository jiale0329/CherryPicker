import { describe, expect, it } from 'vitest';

import { count, groupColumnsByVersion, relativeTime } from './format';

describe('relativeTime', () => {
  const now = new Date('2026-11-18T12:00:00Z');

  it.each([
    ['2026-11-18T11:59:50Z', 'just now'],
    ['2026-11-18T11:56:00Z', '4 min ago'],
    ['2026-11-18T09:00:00Z', '3 hr ago'],
    ['2026-11-17T12:00:00Z', 'yesterday'],
    ['2026-11-08T12:00:00Z', '10 days ago'],
    ['2026-08-18T12:00:00Z', '3 mo ago'],
    ['2024-11-18T12:00:00Z', '2 yr ago'],
  ])('%s -> %s', (input, expected) => {
    expect(relativeTime(input, now)).toBe(expected);
  });

  it('reports never when there is no timestamp', () => {
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime(undefined, now)).toBe('never');
  });

  it('does not show a negative age for clock skew', () => {
    expect(relativeTime('2026-11-18T12:00:30Z', now)).toBe('just now');
  });

  it('reports unknown rather than NaN for a bad value', () => {
    expect(relativeTime('not a date', now)).toBe('unknown');
  });
});

describe('count', () => {
  it('pluralises', () => {
    expect(count(1, 'bug')).toBe('1 bug');
    expect(count(0, 'bug')).toBe('0 bugs');
    expect(count(2, 'bug')).toBe('2 bugs');
  });

  it('takes an irregular plural', () => {
    expect(count(2, 'repository', 'repositories')).toBe('2 repositories');
  });
});

describe('groupColumnsByVersion', () => {
  const columns = [
    { versionLabel: '26.2', stageLabel: 'PRE' },
    { versionLabel: '26.2', stageLabel: '0' },
    { versionLabel: '26.5', stageLabel: 'PRE' },
    { versionLabel: '26.5', stageLabel: '0' },
    { versionLabel: '26.8', stageLabel: 'PRE' },
    { versionLabel: '26.8', stageLabel: '0' },
  ];

  it('turns six columns into three version groups', () => {
    const groups = groupColumnsByVersion(columns);
    expect(groups.map((group) => group.versionLabel)).toEqual(['26.2', '26.5', '26.8']);
    expect(groups.every((group) => group.stages.length === 2)).toBe(true);
  });

  it('preserves column order within a group', () => {
    const groups = groupColumnsByVersion(columns);
    expect(groups[0].stages.map((stage) => stage.stageLabel)).toEqual(['PRE', '0']);
  });

  it('handles a version with a single stage', () => {
    const groups = groupColumnsByVersion([
      { versionLabel: '26.2', stageLabel: 'PRE' },
      { versionLabel: '26.5', stageLabel: 'PRE' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].stages).toHaveLength(1);
  });

  it('does not merge non-adjacent versions, so the header stays aligned with the body', () => {
    // Column order comes from configuration; if a version's stages were split
    // apart, merging them would misalign the two-row header against the cells.
    const groups = groupColumnsByVersion([
      { versionLabel: '26.2', stageLabel: 'PRE' },
      { versionLabel: '26.5', stageLabel: 'PRE' },
      { versionLabel: '26.2', stageLabel: '0' },
    ]);
    expect(groups.map((group) => group.versionLabel)).toEqual(['26.2', '26.5', '26.2']);
  });

  it('returns nothing for no columns', () => {
    expect(groupColumnsByVersion([])).toEqual([]);
  });
});
