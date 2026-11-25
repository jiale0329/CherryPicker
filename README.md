# Release Backport Manager

Tracks which bug fixes have reached which release branches in Azure DevOps, and
automates the cherry-pick plus pull request needed to close the gaps.

No AI services, no LLM calls, no paid APIs. Everything is conventional logic
over the Azure DevOps REST API and the git CLI.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | ADO connectivity and convention discovery | Done — see `docs/phase-0-findings.md` |
| 1 | Foundation, dashboard, release matrix on real data | Done |
| 2 | Broader ADO integration (work items, commit detail) | Partly done in Phase 1 |
| 3 | Backport engine: worktrees, duplicate detection, cherry-pick | Not started |
| 4 | PR automation and status sync | Not started |
| 5 | History, bulk operations, polish | Not started |

Working today: connection health, repository and source-release selectors,
summary cards, the release tracking matrix resolved from live ADO data, search,
pagination, and row selection. The **Create Backport PRs** button is present but
disabled until the Phase 3 engine exists.

## Setup

Prerequisites: Node 22+, Git for Windows, an ADO Personal Access Token with
Code (read & write) and Work Items (read).

```powershell
npm install
copy .env.example .env.local   # then fill in ADO_PAT
npm run ca:export              # only needed behind a TLS-intercepting proxy
npm run db:push
npm run dev
```

Open http://localhost:3000. The first page load seeds default configuration;
press **Refresh** to pull pull requests from ADO into the local cache.

## Verifying the environment

```powershell
npm run tls:check    # can Node complete TLS to ADO, shadcn and npm
```

`GET /api/health` reports the five things that actually break here:
configuration, SQLite, the git executable, the CA bundle, and ADO auth. The
dashboard header turns red and lists remedies when any of them fail.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm run verify` | typecheck + lint + tests. Run before committing. |
| `npm run typecheck` | `next typegen` then `tsc --noEmit` |
| `npm test` | Vitest |
| `npm run db:push` | Apply `prisma/schema.prisma` to SQLite |
| `npm run db:studio` | Browse the database |
| `npm run ca:export` | Export Windows CA roots to `certs/windows-ca-bundle.pem` |
| `npm run tls:check` | Diagnose TLS reachability |

`next typegen` must run before `tsc`, because Next 16 generates the global
`LayoutProps` type into `.next/types`. A bare `tsc --noEmit` fails on a clean
checkout.

## Architecture

```text
src/
  app/
    dashboard/            matrix, summary cards, filters
    api/
      health/             configuration + connectivity checks
      config/             repositories and release columns (seeds on first call)
      matrix/             resolved tracking matrix
      sync/               re-read completed PRs from ADO into the cache
  components/
    dashboard/            matrix, status pill, summary cards
    layout/               header with connection status and selectors
    ui/                   primitives (button, card, skeleton)
  services/
    ado/                  REST client, repositories, pull requests, sync
    backport/             planner, correlation, matrix
    config/               first-run bootstrap
  lib/
    config/               env parsing and validation (server only)
    logging/              structured JSON logging with secret redaction
    prisma/               lazy client singleton
    validation/           API envelope and error translation
  types/
    ado/                  Zod schemas for ADO responses
    backport/             the status model
prisma/schema.prisma
tools/                    read-only ADO probes and environment diagnostics
docs/phase-0-findings.md  what the live project actually looks like
```

### Two decisions worth knowing

**Which commit gets cherry-picked.** Not the PR's source-branch commits. In this
project 83% of completed PRs were squash-merged, so those commits never existed
on the release branch. The planner uses `lastMergeCommit` and picks the command
from its parent count: one parent is a plain cherry-pick, two needs `-m 1`.
See `src/services/backport/planner.ts`.

**How a fix is identified across releases.** Cherry-picking rewrites the sha, so
sha equality is useless. Source branches follow `hotfix/{workItemId}-{slug}`
(853 of 853 parsed during Phase 0), which gives a stable key. Evidence is
ranked, and a patch-id match alone never marks a cell green — it flags the cell
for review instead. See `src/services/backport/correlation.ts`.

## Safety

- The PAT stays server-side. `src/lib/config/env.ts` is server-only, and the
  logger redacts PAT-shaped strings, Basic auth headers and credentials in URLs.
- Git authentication uses `GIT_ASKPASS` with the secret in the child process
  environment, so it never appears in a command line or in `.git/config`.
- Certificate verification is never disabled. The CA bundle is supplied through
  an undici dispatcher scoped to ADO requests.
- Created pull requests never set auto-complete. Target branches carry 11
  blocking policies, so "PR Created, awaiting builds and review" is the normal
  successful outcome.

## Testing

```powershell
npm test
```

Unit tests cover the cherry-pick planner, correlation and status resolution, and
the summary arithmetic, using fixtures taken from real PRs in the project. No
ADO connection is required to run them.
