/**
 * Git safety rules, as executable code rather than convention.
 *
 * The brief's safety requirements are easy to honour by habit and easy to break
 * by accident, so they are enforced at the lowest level: every git invocation
 * passes through `assertArgsAllowed`, and anything that could rewrite history or
 * touch a protected branch is rejected before a process is spawned.
 */

export class GitSafetyError extends Error {
  constructor(
    message: string,
    readonly rule: string,
  ) {
    super(message);
    this.name = 'GitSafetyError';
  }
}

/**
 * Flags that rewrite history or discard work. Forbidden for every subcommand,
 * because no part of the backport workflow needs them.
 */
const FORCE_FLAGS = ['--force', '-f', '--force-with-lease', '--force-if-includes'] as const;

/**
 * Flags forbidden specifically on push, where they would delete or overwrite
 * remote refs. Scoped to push rather than global because some are harmless or
 * necessary elsewhere: `clone --mirror` creates the local bare mirror, and
 * `worktree prune` is part of cleanup.
 */
const PUSH_FORBIDDEN_FLAGS = [
  '--delete',
  '-d',
  '--mirror',
  '--prune',
  '--all',
  '--tags',
  '--follow-tags',
] as const;

/**
 * Subcommands this tool never runs. `prune` here is bare `git prune`; the
 * `prune` argument of `git worktree prune` is unaffected, since only the first
 * non-flag token is treated as the subcommand.
 */
const FORBIDDEN_SUBCOMMANDS = [
  'reset',
  'rebase',
  'filter-branch',
  'filter-repo',
  'gc',
  'prune',
  'reflog',
] as const;

/**
 * Refs the tool must never push to or modify.
 *
 * `hotfix/*` is deliberately *not* here. It was initially, on the assumption
 * that fix branches were protected, but it is where this team puts the branch
 * for every fix including a cherry-pick, so backport branches live there too.
 * Shared integration branches are the ones that must never be written.
 */
export function isProtectedBranch(branch: string): boolean {
  const name = branch.replace(/^refs\/heads\//, '');
  return (
    name.startsWith('release/') || name === 'develop' || name === 'master' || name === 'main'
  );
}

/**
 * Prefixes the tool may create and push.
 *
 * An allowlist rather than a single prefix, so the branch template can follow
 * the team's `hotfix/` convention while `backport/` keeps working.
 */
export const DEFAULT_ALLOWED_PREFIXES = ['hotfix/', 'backport/'] as const;

export function isAllowedBranch(
  branch: string,
  prefixes: readonly string[] = DEFAULT_ALLOWED_PREFIXES,
): boolean {
  const name = branch.replace(/^refs\/heads\//, '');
  return prefixes.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}

/**
 * Validates an argv array before it is handed to git.
 *
 * `push` gets the strictest treatment because it is the only operation with
 * effects outside the local worktree.
 */
export function assertArgsAllowed(
  args: readonly string[],
  options: { allowedPrefixes?: readonly string[] } = {},
): void {
  const prefixes = options.allowedPrefixes ?? DEFAULT_ALLOWED_PREFIXES;

  for (const arg of args) {
    if ((FORCE_FLAGS as readonly string[]).includes(arg)) {
      throw new GitSafetyError(
        `Refusing to run git with ${arg}: this tool never force-updates or discards work.`,
        'no-force',
      );
    }
  }

  const subcommand = args.find((arg) => !arg.startsWith('-'));
  if (subcommand && (FORBIDDEN_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new GitSafetyError(
      `Refusing to run "git ${subcommand}": not part of the backport workflow.`,
      'no-destructive-subcommand',
    );
  }

  if (subcommand !== 'push') return;

  for (const arg of args) {
    if ((PUSH_FORBIDDEN_FLAGS as readonly string[]).includes(arg)) {
      throw new GitSafetyError(
        `Refusing to push with ${arg}: it could delete or overwrite remote refs.`,
        'no-destructive-push',
      );
    }
  }

  // Everything after `push <remote>` that is not a flag is a refspec.
  const operands = args.slice(args.indexOf('push') + 1).filter((arg) => !arg.startsWith('-'));
  const refspecs = operands.slice(1);

  if (refspecs.length === 0) {
    throw new GitSafetyError(
      'Refusing to push without an explicit refspec, which could push more than intended.',
      'explicit-refspec',
    );
  }

  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) {
      throw new GitSafetyError(
        `Refusing to push "${refspec}": a leading + is a forced update.`,
        'no-force',
      );
    }
    if (refspec.startsWith(':')) {
      throw new GitSafetyError(
        `Refusing to push "${refspec}": a leading colon deletes the remote branch.`,
        'no-delete',
      );
    }

    // Destination is the right-hand side of src:dst, or the whole refspec.
    const destination = refspec.includes(':') ? refspec.split(':')[1] : refspec;

    if (isProtectedBranch(destination)) {
      throw new GitSafetyError(
        `Refusing to push to "${destination}": release, develop, master and main ` +
        'branches are never written by this tool.',
        'protected-branch',
      );
    }

    if (!isAllowedBranch(destination, prefixes)) {
      throw new GitSafetyError(
        `Refusing to push to "${destination}": only branches under ` +
        `${prefixes.map((p) => `"${p}"`).join(' or ')} may be pushed.`,
        'prefix-not-allowed',
      );
    }
  }
}

/** Guards the branch a worktree is about to be created on. */
export function assertCanCreateBranch(
  branch: string,
  prefixes: readonly string[] = DEFAULT_ALLOWED_PREFIXES,
): void {
  if (isProtectedBranch(branch)) {
    throw new GitSafetyError(
      `Refusing to create or modify "${branch}": it is a protected branch.`,
      'protected-branch',
    );
  }
  if (!isAllowedBranch(branch, prefixes)) {
    throw new GitSafetyError(
      `Refusing to create "${branch}": branch names must start with ` +
      `${prefixes.map((prefix) => `"${prefix}"`).join(' or ')}.`,
      'prefix-not-allowed',
    );
  }
}
