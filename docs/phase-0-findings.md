# Phase 0 — ADO connectivity and convention findings

Gathered by read-only probes in `tools/` against `https://dev.azure.com/jblprd/jemsmm`
on the agreed scope of 4 repositories. No writes were performed.

## Scope

| Repository | Size | 26.2.1.PRE | 26.2.1.0 | 26.5.1.PRE | 26.5.1.0 | 26.8.1.PRE | 26.8.1.0 |
|---|---|---|---|---|---|---|---|
| core-sqldatabase | 53 MB | yes | yes | yes | yes | — | — |
| core-consolidated-database | 11 MB | yes | — | yes | — | yes | yes |
| core-application | 822 MB | yes | yes | yes | yes | yes | yes |
| mms-wip-service | 4 MB | yes | yes | yes | yes | yes | yes |

Branch coverage is ragged, so the matrix must render per repository and show absent
branches as a disabled, non-actionable cell rather than "Pending".

Local mirror cost for all four repos is roughly 890 MB, dominated by `core-application`.
Acceptable for a local bare mirror plus worktrees.

## Volume

Completed PRs per repo × branch (what the dashboard must page through):

| Repository | 26.2.1.PRE | 26.2.1.0 | 26.5.1.PRE | 26.5.1.0 | 26.8.1.PRE | 26.8.1.0 |
|---|---|---|---|---|---|---|
| core-sqldatabase | 53 | 76 | 75 | 53 | — | — |
| core-consolidated-database | 0 | — | 1 | — | 133 | 99 |
| core-application | 49 | 76 | 53 | 44 | 46 | 43 |
| mms-wip-service | 11 | 22 | 6 | 4 | 5 | 4 |

853 completed PRs in scope. Small enough to sync eagerly and cache in SQLite.

## Correlation key — the important result

Source branch naming is `hotfix/{workItemId}-{slug}`, and **853 of 853** sampled PRs
parsed cleanly (848 `hotfix/`, 5 `feature/`). Work item linkage is present on every PR
sampled.

This gives a stable identity for "the same fix across releases" that survives
cherry-picking, which is the central problem the tool has to solve. The matrix was
reconstructed from this key alone and looks correct.

Confidence ordering stays as designed: our own execution records and discovered
backport PRs outrank work-item correlation, and `git patch-id` evidence is reported as
"likely present, review" rather than silently marked merged.

## Merge strategy — mixed, must handle both

Sample of 48 completed PRs across all four repos:

- 40 squash (`completionOptions.squashMerge = true`, `mergeStrategy = squash`)
- 8 `noFastForward` (true merge commit)
- `lastMergeCommit` populated for 48/48

Verified commit shapes:

| PR | Strategy | `lastMergeCommit` parents | Message form |
|---|---|---|---|
| 384144 | squash | 1 | `core-application \| 26.2.1.PRE \| optimized ef query for ...` |
| 341609 | noFastForward | 2 | `Merged PR 341609: Core-Application \| 26.2.1.0 \| Replaced ThenBy ...` |

Source-branch commit counts ranged 1–7, with 8 of 48 PRs having more than one commit.

**Engine rule:** cherry-pick `lastMergeCommit`, not the source-branch commit list.
Use a plain cherry-pick when it has one parent, and `-m 1` when it has two. Replaying
the source-branch commits would be wrong for the 83% that were squashed.

## Propagation direction — the brief was right

Of 81 fixes spanning two or more version lines, the first branch to receive the fix was:

- 26.2 — 49 (60%)
- 26.5 — 29 (36%)
- 26.8 — 3 (4%)

So fixes land on the oldest maintained line first and move forward to 26.5 and 26.8.

Within a single version, `PRE` lands before `.0` in 274 of 288 cases (95%). `PRE` → `.0`
is therefore a real propagation step, not a parallel branch, and belongs in the matrix
as its own column exactly as requested.

Default source will be `release/26.2.1.PRE`, with any of the six selectable as source
and the rest offered as targets.

## Commit message convention

Squash messages embed the target branch: `{repo} | {branch} | {description}`.

A naive cherry-pick into 26.5.1.PRE would carry the text `| 26.2.1.PRE |` and be wrong.
The engine will rewrite that token to the target branch and append a
`(cherry picked from commit <sha>)` trailer, which also feeds duplicate detection later.

## Branch policies — 11 blocking policies on target branches

Checked `core-application` at `release/26.5.1.PRE` and `release/26.8.1.PRE`; both identical:

| Policy | Consequence for auto-created PRs |
|---|---|
| Work item linking (blocking) | Must link a work item or the PR can never complete. Satisfied from the `hotfix/{id}` key and the original PR's links. |
| Commit author email validation (blocking) | The cherry-pick commit identity must pass validation. See risk below. |
| Required reviewers (blocking, 1) | A specific reviewer must be added. |
| Minimum reviewers (1, `creatorVoteCounts = false`) | The creator's own vote does not count, so a non-creator reviewer is mandatory. |
| Build validation ×2 (defs 4173, 10179, blocking) | Every created PR queues two builds. |
| Comment requirements (blocking) | Open comments block completion. |
| Require a merge strategy (blocking) | Explains the mixed squash / noFastForward history. |
| Status (blocking) | External status gate. |

Two consequences:

1. Auto-complete stays off, as already specified. A created PR legitimately sits pending
   builds and review, so "PR Created / awaiting approval" is the normal steady state and
   the dashboard should present it as success, not as something stalled.
2. PR creation must attach a work item and at least one reviewer, or it produces PRs
   that cannot merge. Both become settings.

## Commit identity

`git config --global user.email` is `68922276+jiale0329@users.noreply.github.com`, a
GitHub noreply address, and the global value would otherwise be inherited as the
*committer* of every cherry-pick the tool performs.

An earlier draft of this document claimed that would fail the blocking **Commit author
email validation** policy. That was wrong: the policy's `authorEmailPatterns` list is
empty, so it imposes no restriction. Corrected here rather than silently removed.

It still matters for traceability, so the backport worktree sets `user.name` /
`user.email` explicitly per invocation via `-c` and never inherits the global value.
Default comes from the PAT identity resolved via `_apis/connectionData`:
`JiaLe Loh <JiaLe_Loh@jabil.com>`. Overridable in settings.

## API notes for the client implementation

- `api-version=7.1` works for repositories, refs, pullrequests, commits and workitems.
  Branch policies need `7.1-preview.1` at `_apis/git/policy/configurations`.
- **Do not URL-escape the slashes in `searchCriteria.targetRefName`.** Passing
  `refs%2Fheads%2Frelease%2F26.2.1.PRE` is accepted but silently ignores the filter and
  returns unfiltered results. This produced a misleading early reading during the probe.
- TLS to `dev.azure.com` verifies cleanly. The `NODE_TLS_REJECT_UNAUTHORIZED=0` present in
  the user's MCP config is not needed and will not be used.
- Basic auth with an empty username and the PAT as password works as expected.

## Environment

- `git` on `PATH` resolves to a zero-byte stub at `C:\WINDOWS\system32\git`, which shadows
  the real install because System32 precedes `C:\Program Files\Git\cmd`. The Git service
  must always spawn an absolute configured path; `GIT_EXECUTABLE` is set in `.env.local`
  to `C:\Program Files\Git\cmd\git.exe` (git 2.48.1).
- Node 22.14.0, npm 10.9.6.
- PowerShell gotcha hit while writing the probes: `?` is a legal variable-name character,
  so `"$repo?api-version=7.1"` parses as `${repo?api}`. Irrelevant to the app, noted so the
  probe scripts are not "fixed" back.

## Resolved decisions

### Reviewers on auto-created PRs

The blocking "Required reviewers" policy names a single id,
`b159972b-1d79-4885-9be6-802c34944072`, which resolves to the container group
`[jemsmm]\Code Reviewer`. ADO attaches policy-required reviewers automatically on PR
creation, so the tool does not add it.

"Minimum number of reviewers" is 1 with `creatorVoteCounts = false`, so a non-creator
human vote is still required. Observed on real PRs, that individual is added manually:

| PR | Created by | Individual reviewer (vote 10) |
|---|---|---|
| 387113 | JiaLe Loh | MoonHui Ng |
| 385071 | Adam Szeszak | Volodymyr Malyarevskiy |
| 382518 | MoonHui Ng | WooiHuat Choong |
| 380599 | JiaLe Loh | MoonHui Ng |

**Decision:** copy the individual (non-container) reviewers from the original PR onto the
backport PR. Settings allow overriding with a fixed reviewer list, or none.

### Commit identity

Default to the PAT identity, `JiaLe Loh <JiaLe_Loh@jabil.com>`, passed explicitly per git
invocation. Overridable in settings.

### Default dashboard filters

Two defaults were requested: show only the current user's pull requests, and
hide fixes whose work item is Done. The first is safe. The second is not, and
the numbers are the reason.

Work item states in this project are a custom set, all of type Bug:

| State | Count (sampled 96) |
|---|---|
| Done | 80 |
| Fixed | 7 |
| Back Merged | 5 |
| Closed Rejected | 2 |
| Confirmed Fixed | 1 |
| Ready to Test | 1 |

Cross-tabulating state against actual backport completeness for the default
view (`core-application`, `release/26.2.1.PRE`, 49 fixes):

| State | Fixes | Still missing a backport | Missing cells |
|---|---|---|---|
| Done | 41 | 27 | 70 |
| Closed Rejected | 5 | 5 | 10 |
| Back Merged | 2 | 0 | 0 |
| Ready to Test | 1 | 1 | 1 |

Filter impact on that view:

| Filter | Rows |
|---|---|
| none | 49 |
| only mine | 3 |
| work item not Done | 8 |
| **only mine AND not Done** | **0** |

Three conclusions:

1. "Not Done" would hide 27 fixes that are still missing 70 backports. The team
   closes bugs without waiting for every release to be backported, so Done does
   not mean the backport is finished. Defaulting to it would hide most of the
   work the dashboard exists to find.
2. Combined with "only mine" the default view is empty, which would look like a
   broken dashboard.
3. `Back Merged` is the state that actually correlates with a completed
   backport: 2 fixes, 0 missing. It is the team's own marker for propagation.
   `Closed Rejected` is the state genuinely worth hiding, since a rejected bug
   should not be backported at all.

**Decision:** "Only my PRs" defaults on, as requested, and is a visible toggle.
The work item filter defaults to excluding `Closed Rejected` only, not `Done`.
A state selector offers any state, so hiding `Done` remains one click away.
Every filtered view reports how many fixes were hidden and how many backports
those hidden fixes are still missing, so a filter can never quietly conceal
outstanding work.

### No propagation chaining

`PRE` → `.0` and 26.2 → 26.5 → 26.8 are handled manually by the developer. The tool
presents all six branches as columns and acts only on the source and targets explicitly
selected. No inferred cascade.
