import { describe, expect, it } from 'vitest';

import {
  assertArgsAllowed,
  assertCanCreateBranch,
  GitSafetyError,
  isAllowedBranch,
  isProtectedBranch,
} from './guards';

/**
 * These tests encode the brief's git safety requirements. They are not about
 * code coverage: each one corresponds to a way this tool could damage a real
 * repository, so a failure here means the safety net is gone.
 */

describe('isProtectedBranch', () => {
  it.each(['release/26.2.1.PRE', 'refs/heads/release/26.8.1.0', 'develop', 'master', 'main'])(
    'protects %s',
    (branch) => {
      expect(isProtectedBranch(branch)).toBe(true);
    },
  );

  it('does not protect branches the tool creates', () => {
    expect(isProtectedBranch('backport/PR-1842-26.5.1.PRE')).toBe(false);
  });

  it('does not protect hotfix branches, which is where fix branches live', () => {
    // hotfix/* was protected initially on the assumption that fix branches were
    // off limits. It is in fact the team's namespace for every fix branch
    // including cherry-picks, so backport branches are created there.
    expect(isProtectedBranch('hotfix/1444759-thing-on-release-26.2.1.0')).toBe(false);
  });
});

describe('isAllowedBranch', () => {
  it('accepts the team hotfix convention', () => {
    expect(isAllowedBranch('hotfix/1444759-fix-thing-on-release-26.2.1.0')).toBe(true);
  });

  it('accepts the backport prefix', () => {
    expect(isAllowedBranch('backport/PR-1-26.5')).toBe(true);
    expect(isAllowedBranch('refs/heads/backport/PR-1-26.5')).toBe(true);
  });

  it('rejects protected and unrelated branches', () => {
    expect(isAllowedBranch('release/26.5.1.0')).toBe(false);
    expect(isAllowedBranch('feature/whatever')).toBe(false);
    expect(isAllowedBranch('develop')).toBe(false);
  });

  it('rejects a bare prefix with no name after it', () => {
    expect(isAllowedBranch('hotfix/')).toBe(false);
    expect(isAllowedBranch('backport/')).toBe(false);
  });

  it('honours a narrowed prefix list', () => {
    expect(isAllowedBranch('backport/x', ['hotfix/'])).toBe(false);
    expect(isAllowedBranch('hotfix/x', ['hotfix/'])).toBe(true);
  });
});

describe('assertArgsAllowed', () => {
  it('allows an ordinary push of a backport branch', () => {
    expect(() =>
      assertArgsAllowed(['push', 'origin', 'backport/PR-1842-26.5.1.PRE']),
    ).not.toThrow();
  });

  it('allows a src:dst refspec to a backport branch', () => {
    expect(() =>
      assertArgsAllowed(['push', 'origin', 'HEAD:refs/heads/backport/PR-1842-26.5.1.PRE']),
    ).not.toThrow();
  });

  it.each(['--force', '-f', '--force-with-lease', '--force-if-includes'])(
    'refuses %s anywhere in the arguments',
    (flag) => {
      expect(() => assertArgsAllowed(['push', 'origin', 'backport/x', flag])).toThrow(
        GitSafetyError,
      );
    },
  );

  it('refuses a + prefixed refspec, which is a forced update', () => {
    expect(() => assertArgsAllowed(['push', 'origin', '+backport/PR-1-26.5'])).toThrow(
      /forced update/i,
    );
  });

  it('refuses a colon prefixed refspec, which deletes the remote branch', () => {
    expect(() => assertArgsAllowed(['push', 'origin', ':backport/PR-1-26.5'])).toThrow(
      /deletes the remote branch/i,
    );
  });

  it('refuses --delete', () => {
    expect(() => assertArgsAllowed(['push', '--delete', 'origin', 'backport/x'])).toThrow(
      GitSafetyError,
    );
  });

  it('refuses to push to a release branch', () => {
    expect(() => assertArgsAllowed(['push', 'origin', 'HEAD:refs/heads/release/26.5.1.0'])).toThrow(
      /protected|never written/i,
    );
  });

  it.each(['develop', 'master', 'main'])('refuses to push to %s', (branch) => {
    expect(() => assertArgsAllowed(['push', 'origin', `HEAD:refs/heads/${branch}`])).toThrow(
      GitSafetyError,
    );
  });

  it('refuses to push a branch outside the backport prefix', () => {
    expect(() => assertArgsAllowed(['push', 'origin', 'experiment/foo'])).toThrow(
      /only branches under/i,
    );
  });

  it('refuses a push with no refspec, which could push more than intended', () => {
    expect(() => assertArgsAllowed(['push', 'origin'])).toThrow(/explicit refspec/i);
    expect(() => assertArgsAllowed(['push'])).toThrow(/explicit refspec/i);
  });

  it('allows a push to the team hotfix convention', () => {
    expect(() =>
      assertArgsAllowed([
        'push',
        'origin',
        'HEAD:refs/heads/hotfix/1444759-fix-phantom-parent-on-release-26.2.1.0',
      ]),
    ).not.toThrow();
  });

  it('honours a narrowed prefix list', () => {
    expect(() =>
      assertArgsAllowed(['push', 'origin', 'bp/PR-1-26.5'], { allowedPrefixes: ['bp/'] }),
    ).not.toThrow();
    expect(() =>
      assertArgsAllowed(['push', 'origin', 'backport/PR-1-26.5'], { allowedPrefixes: ['bp/'] }),
    ).toThrow(GitSafetyError);
  });

  it.each(['reset', 'rebase', 'filter-branch', 'gc', 'reflog'])(
    'refuses the %s subcommand',
    (subcommand) => {
      expect(() => assertArgsAllowed([subcommand, '--hard'])).toThrow(GitSafetyError);
    },
  );

  it('allows the read and apply commands the workflow needs', () => {
    for (const args of [
      ['fetch', 'origin'],
      ['cherry-pick', '-x', 'abc123'],
      ['cherry-pick', '-x', '-m', '1', 'abc123'],
      ['cherry-pick', '--abort'],
      ['worktree', 'add', '/tmp/wt', 'release/26.5.1.PRE'],
      ['worktree', 'remove', '/tmp/wt'],
      // Cleanup after a worktree directory is deleted. Must stay allowed, so
      // it is only `git prune` that is blocked, not `git worktree prune`.
      ['worktree', 'prune'],
      // Creates the local bare mirror. `--mirror` is dangerous on push, not clone.
      ['clone', '--mirror', 'https://example.invalid/repo', '/tmp/m.git'],
      ['merge-base', '--is-ancestor', 'a', 'b'],
      ['cherry', 'release/26.5.1.PRE', 'abc123', 'abc123~1'],
      ['log', '--oneline', '-20'],
      ['status', '--porcelain'],
      ['diff', '--name-only'],
    ]) {
      expect(() => assertArgsAllowed(args)).not.toThrow();
    }
  });

  it('still refuses push --mirror and push --all', () => {
    expect(() => assertArgsAllowed(['push', '--mirror', 'origin', 'backport/x'])).toThrow(
      GitSafetyError,
    );
    expect(() => assertArgsAllowed(['push', '--all', 'origin', 'backport/x'])).toThrow(
      GitSafetyError,
    );
  });

  it('refuses bare git prune but allows git worktree prune', () => {
    expect(() => assertArgsAllowed(['prune'])).toThrow(GitSafetyError);
    expect(() => assertArgsAllowed(['worktree', 'prune'])).not.toThrow();
  });
});

describe('assertCanCreateBranch', () => {
  it('allows the team hotfix convention', () => {
    expect(() =>
      assertCanCreateBranch('hotfix/1444759-fix-phantom-parent-on-release-26.2.1.0'),
    ).not.toThrow();
  });

  it('allows a backport branch', () => {
    expect(() => assertCanCreateBranch('backport/PR-1842-26.5.1.PRE')).not.toThrow();
  });

  it('refuses a release branch', () => {
    expect(() => assertCanCreateBranch('release/26.5.1.PRE')).toThrow(/protected/i);
  });

  it('refuses a branch outside the allowed prefixes', () => {
    expect(() => assertCanCreateBranch('tmp/scratch')).toThrow(/must start with/i);
  });
});
