import { describe, expect, it } from 'vitest';

import {
  renderTemplate,
  reviewersToCopy,
  stripExistingVersionTag,
  versionLabelFor,
  type TemplateVars,
} from './prCreation';
import type { AdoPullRequest } from '@/types/ado/schemas';

const vars: TemplateVars = {
  prId: 369344,
  repo: 'core-sqldatabase',
  sourceBranch: 'release/26.2.1.PRE',
  targetBranch: 'release/26.2.1.0',
  targetVersion: '26.2.1.0',
  originalTitle: 'wrong top level serial number',
  pickSha: '451c99f0fd56d4a0b088f51ce8dba848cf6e594b',
};

describe('renderTemplate', () => {
  it('fills the documented placeholders', () => {
    expect(renderTemplate('{repo} | {targetVersion} | {originalTitle}', vars)).toBe(
      'core-sqldatabase | 26.2.1.0 | wrong top level serial number',
    );
  });

  it('produces the team title format', () => {
    expect(
      renderTemplate('Cherry-Pick | {repo} | {targetVersion} | {originalTitle}', vars),
    ).toBe('Cherry-Pick | core-sqldatabase | 26.2.1.0 | wrong top level serial number');
  });

  it('leaves unknown placeholders alone rather than emitting undefined', () => {
    expect(renderTemplate('{repo} {nope}', vars)).toBe('core-sqldatabase {nope}');
  });

  it('substitutes every occurrence', () => {
    expect(renderTemplate('{prId}-{prId}', vars)).toBe('369344-369344');
  });
});

describe('versionLabelFor', () => {
  it.each([
    ['release/26.5.1.PRE', '26.5.1.PRE'],
    ['refs/heads/release/26.8.1.0', '26.8.1.0'],
    ['develop', 'develop'],
  ])('%s -> %s', (input, expected) => {
    expect(versionLabelFor(input)).toBe(expected);
  });
});

describe('stripExistingVersionTag', () => {
  it('removes the repo and release prefix this project embeds in titles', () => {
    // Real shape: "core-application | 26.2.1.PRE | optimized ef query"
    expect(stripExistingVersionTag('core-application | 26.2.1.PRE | optimized ef query')).toBe(
      'optimized ef query',
    );
  });

  it('keeps pipes that are part of the description', () => {
    expect(
      stripExistingVersionTag('core-sqldatabase | 26.5.1.0 | fixed a | b parsing issue'),
    ).toBe('fixed a | b parsing issue');
  });

  it('leaves a title with no version tag untouched', () => {
    expect(stripExistingVersionTag('SIN | BOM Valid To dates are wrong')).toBe(
      'SIN | BOM Valid To dates are wrong',
    );
  });

  it('strips a longer prefix, as seen on PR 369343', () => {
    // This exact title produced a doubled result in the first real execution:
    // "packout | 26.2.1.0 | Cherry-Pick | packout | 26.2.1.PRE | Fix phantom…"
    expect(
      stripExistingVersionTag(
        'Cherry-Pick | packout | 26.2.1.PRE | Fix phantom parent resolution for container sub-item hierarchy generation',
      ),
    ).toBe('Fix phantom parent resolution for container sub-item hierarchy generation');
  });

  it('does not strip a version that appears in the description', () => {
    expect(stripExistingVersionTag('SIN | upgrade fails | moving from 1.2 to 1.3')).toBe(
      'SIN | upgrade fails | moving from 1.2 to 1.3',
    );
  });

  it('is idempotent, so re-backporting does not keep trimming', () => {
    const once = stripExistingVersionTag('packout | 26.2.1.PRE | fix the thing');
    expect(stripExistingVersionTag(once)).toBe(once);
  });

  it('trims surrounding whitespace', () => {
    expect(stripExistingVersionTag('  plain title  ')).toBe('plain title');
  });
});

function pr(overrides: Partial<AdoPullRequest> = {}): AdoPullRequest {
  return {
    pullRequestId: 1,
    title: 'x',
    status: 'completed',
    createdBy: { id: 'author-id', displayName: 'Author' },
    creationDate: '2026-01-01T00:00:00Z',
    sourceRefName: 'refs/heads/hotfix/1-x',
    targetRefName: 'refs/heads/release/26.2.1.PRE',
    reviewers: [],
    ...overrides,
  } as AdoPullRequest;
}

describe('reviewersToCopy', () => {
  it('copies individual reviewers', () => {
    const result = reviewersToCopy(
      pr({
        reviewers: [
          { id: 'moonhui', displayName: 'MoonHui Ng', vote: 10, isContainer: false },
          { id: 'wooi', displayName: 'WooiHuat Choong', vote: 0, isContainer: false },
        ],
      }),
    );
    expect(result).toEqual(['moonhui', 'wooi']);
  });

  it('excludes groups, which do not satisfy the minimum-reviewer policy', () => {
    // [jemsmm]\Code Reviewer is attached by policy and is a container.
    const result = reviewersToCopy(
      pr({
        reviewers: [
          { id: 'group-id', displayName: '[jemsmm]\\Code Reviewer', vote: 10, isContainer: true },
          { id: 'moonhui', displayName: 'MoonHui Ng', vote: 10, isContainer: false },
        ],
      }),
    );
    expect(result).toEqual(['moonhui']);
  });

  it('excludes the original author, whose own vote would not count', () => {
    const result = reviewersToCopy(
      pr({
        createdBy: { id: 'author-id', displayName: 'Author' },
        reviewers: [{ id: 'author-id', displayName: 'Author', vote: 10, isContainer: false }],
      }),
    );
    expect(result).toEqual([]);
  });

  it('excludes the tool identity so the creator is never their own reviewer', () => {
    const result = reviewersToCopy(
      pr({
        reviewers: [
          { id: 'me', displayName: 'JiaLe Loh', vote: 10, isContainer: false },
          { id: 'moonhui', displayName: 'MoonHui Ng', vote: 10, isContainer: false },
        ],
      }),
      { excludeIdentityIds: ['me'] },
    );
    expect(result).toEqual(['moonhui']);
  });

  it('returns an empty list when only groups reviewed', () => {
    const result = reviewersToCopy(
      pr({
        reviewers: [{ id: 'group', displayName: 'Group', vote: 10, isContainer: true }],
      }),
    );
    expect(result).toEqual([]);
  });
});
