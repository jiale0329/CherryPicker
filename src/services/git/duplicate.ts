import type { Evidence } from '@/services/backport/correlation';
import type { Git, GitExecOptions } from '@/services/git/gitExec';

/**
 * Duplicate detection: is this fix already in the target branch?
 *
 * Comparing commit hashes is not enough, because cherry-picking produces a new
 * hash. Three independent checks run, strongest first, and the result reports
 * *evidence* rather than a verdict:
 *
 *  1. ancestry - the exact commit is reachable from the target branch.
 *     Definitive, but rare, since a backport normally rewrites the hash.
 *  2. cherry-pick trailer - a commit on the target branch mentions the original
 *     sha, which `cherry-pick -x` writes. Strong, and the usual positive hit
 *     for anything this tool created.
 *  3. patch equivalence - `git cherry` compares patch ids. Strong for detecting
 *     a manual backport, but weak as proof: an equivalent patch may be an
 *     unrelated change touching the same lines, or a partial application.
 *
 * Per the brief, a patch-id match alone never concludes the fix is present. It
 * is surfaced for a human to judge, which is why `alreadyPresent` is only set
 * by ancestry or a trailer.
 */

export interface DuplicateCheck {
  /** Safe to treat the fix as already in the target branch. */
  alreadyPresent: boolean;
  /** Something equivalent was found, but it needs review before trusting. */
  likelyPresent: boolean;
  evidence: Evidence[];
  /** Commits on the target branch that look like this fix. */
  candidates: { sha: string; subject: string; reason: string }[];
}

export interface DuplicateCheckInput {
  git: Git;
  options: GitExecOptions;
  /** Commit that landed on the source release branch. */
  commitSha: string;
  /** Fully qualified target ref, e.g. origin/release/26.5.1.PRE. */
  targetRef: string;
  /** Work item id, used to spot a manual backport by branch convention. */
  workItemId?: string | null;
}

export async function checkForDuplicate(input: DuplicateCheckInput): Promise<DuplicateCheck> {
  const { git, options, commitSha, targetRef } = input;
  const evidence: Evidence[] = [];
  const candidates: DuplicateCheck['candidates'] = [];

  let alreadyPresent = false;
  let likelyPresent = false;

  // --- 1. ancestry ---------------------------------------------------------
  const ancestry = await git.tryRun(
    ['merge-base', '--is-ancestor', commitSha, targetRef],
    options,
  );
  if (ancestry.exitCode === 0) {
    alreadyPresent = true;
    evidence.push({
      source: 'ancestry',
      confidence: 'definitive',
      detail: `${short(commitSha)} is already an ancestor of ${targetRef}.`,
    });
    // Nothing else can change the answer.
    return { alreadyPresent, likelyPresent, evidence, candidates };
  }

  // --- 2. cherry-pick trailer ---------------------------------------------
  // `cherry-pick -x` writes "(cherry picked from commit <sha>)". --fixed-strings
  // keeps the sha from being read as a regex.
  const trailer = await git.tryRun(
    [
      'log',
      targetRef,
      '--fixed-strings',
      `--grep=cherry picked from commit ${commitSha}`,
      '--format=%H%x1f%s',
      '--max-count=5',
    ],
    options,
  );

  if (trailer.exitCode === 0 && trailer.stdout.trim().length > 0) {
    for (const line of trailer.stdout.trim().split('\n')) {
      const [sha, subject] = line.split('\u001f');
      candidates.push({
        sha,
        subject: subject ?? '',
        reason: 'records a cherry-pick of the original commit',
      });
    }
    alreadyPresent = true;
    evidence.push({
      source: 'commit-trailer',
      confidence: 'strong',
      detail:
        `${candidates.length} commit(s) on ${targetRef} record a cherry-pick of ` +
        `${short(commitSha)}.`,
    });
    return { alreadyPresent, likelyPresent, evidence, candidates };
  }

  // --- 3. patch equivalence ------------------------------------------------
  // `git cherry <upstream> <head> <limit>` compares patch ids. Limiting head to
  // the single commit keeps the output to one line: "-" means an equivalent
  // patch exists upstream, "+" means it does not.
  const cherry = await git.tryRun(
    ['cherry', targetRef, commitSha, `${commitSha}~1`],
    options,
  );

  if (cherry.exitCode === 0) {
    const line = cherry.stdout.trim().split('\n')[0] ?? '';
    if (line.startsWith('-')) {
      likelyPresent = true;
      evidence.push({
        source: 'patch-id',
        confidence: 'weak',
        detail:
          `git cherry reports an equivalent patch already on ${targetRef}. ` +
          'This may be the same fix applied by hand, or an unrelated change with ' +
          'an identical diff - review before skipping.',
      });
    }
  }

  if (evidence.length === 0) {
    evidence.push({
      source: 'patch-id',
      confidence: 'strong',
      detail: `No equivalent of ${short(commitSha)} found on ${targetRef}.`,
    });
  }

  return { alreadyPresent, likelyPresent, evidence, candidates };
}

function short(sha: string): string {
  return sha.slice(0, 10);
}
