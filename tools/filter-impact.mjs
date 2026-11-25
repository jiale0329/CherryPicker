/**
 * Measures what the two proposed default filters would hide.
 *
 * Cross-tabulates work item state against whether the fix is actually fully
 * backported, for the default view (core-application, release/26.2.1.PRE).
 * If "not Done" hides fixes that still have missing backports, it is a bad
 * default regardless of how reasonable it sounds.
 */
import { readFileSync } from 'node:fs';

import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';
import { Agent } from 'undici';

loadEnv({ path: '.env.local', quiet: true });

const ca = readFileSync(process.env.ADO_CA_BUNDLE, 'utf8');
const dispatcher = new Agent({ connect: { ca } });
const auth = 'Basic ' + Buffer.from(':' + process.env.ADO_PAT).toString('base64');

const REPO = 'core-application';
const SOURCE = 'release/26.2.1.PRE';
const ME = 'fa99f255-8055-62db-ba70-3532dadcd08f';

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL }),
});

try {
  const matrixRes = await fetch(
    `http://localhost:3000/api/matrix?repository=${REPO}&source=${SOURCE}&pageSize=200`,
  );
  const matrix = await matrixRes.json();

  const ids = [...new Set(matrix.rows.map((r) => r.workItemId).filter(Boolean))];
  const stateById = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const url =
      `${process.env.ADO_ORG_URL}/${process.env.ADO_PROJECT}/_apis/wit/workitems` +
      `?ids=${batch.join(',')}&fields=System.State&errorPolicy=omit&api-version=7.1`;
    const data = await fetch(url, { headers: { Authorization: auth }, dispatcher }).then((r) =>
      r.json(),
    );
    for (const item of data.value ?? []) {
      if (item?.fields) stateById.set(item.id, item.fields['System.State']);
    }
  }

  const authorIds = new Map(
    (
      await prisma.cachedPullRequest.findMany({
        where: { repositoryName: REPO, targetBranch: SOURCE },
        select: { pullRequestId: true, authorId: true },
      })
    ).map((r) => [r.pullRequestId, r.authorId]),
  );

  const rows = matrix.rows.map((row) => {
    const targets = row.cells.filter(
      (c) => c.branchName !== SOURCE && c.status !== 'UNAVAILABLE',
    );
    return {
      pr: row.pullRequestId,
      state: stateById.get(row.workItemId) ?? '(unknown)',
      mine: authorIds.get(row.pullRequestId) === ME,
      complete: targets.length > 0 && targets.every((c) => c.status === 'MERGED'),
      missing: targets.filter((c) => c.status !== 'MERGED').length,
    };
  });

  console.log(`rows on ${SOURCE}: ${rows.length}\n`);

  const byState = new Map();
  for (const r of rows) {
    const e = byState.get(r.state) ?? { total: 0, incomplete: 0, missingCells: 0 };
    e.total += 1;
    if (!r.complete) e.incomplete += 1;
    e.missingCells += r.missing;
    byState.set(r.state, e);
  }

  console.log('work item state      fixes   with missing backports   missing cells');
  console.log('-'.repeat(72));
  for (const [state, e] of [...byState].sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${state.padEnd(20)} ${String(e.total).padStart(4)}   ${String(e.incomplete).padStart(20)}   ${String(e.missingCells).padStart(12)}`,
    );
  }

  const notDone = rows.filter((r) => r.state !== 'Done');
  const mine = rows.filter((r) => r.mine);
  const both = rows.filter((r) => r.mine && r.state !== 'Done');
  const hiddenWork = rows.filter((r) => r.state === 'Done' && !r.complete);

  console.log('\nfilter impact on the default view:');
  console.log(`  no filter                 ${String(rows.length).padStart(3)} rows`);
  console.log(`  mine only                 ${String(mine.length).padStart(3)} rows`);
  console.log(`  not Done only             ${String(notDone.length).padStart(3)} rows`);
  console.log(`  mine AND not Done         ${String(both.length).padStart(3)} rows`);
  console.log(
    `\n  fixes that are Done but STILL missing a backport: ${hiddenWork.length}` +
      ` (${hiddenWork.reduce((n, r) => n + r.missing, 0)} missing cells)`,
  );
} catch (error) {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
