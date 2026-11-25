/**
 * Checks feasibility of two proposed default filters:
 *   1. only pull requests created by the authenticated user
 *   2. only fixes whose work item is not Done
 *
 * Specifically: does PR.createdBy.id match connectionData's authenticatedUser.id,
 * how many cached PRs would survive filter 1, and what work item states exist.
 */
import { readFileSync } from 'node:fs';

import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';
import { Agent } from 'undici';

// Next loads .env.local automatically; standalone node scripts do not.
loadEnv({ path: '.env.local', quiet: true });

const ca = readFileSync(process.env.ADO_CA_BUNDLE, 'utf8');
const dispatcher = new Agent({ connect: { ca } });
const auth = 'Basic ' + Buffer.from(':' + process.env.ADO_PAT).toString('base64');
const org = process.env.ADO_ORG_URL;
const project = process.env.ADO_PROJECT;

async function ado(path, query = {}, apiVersion = '7.1') {
  const params = new URLSearchParams({ 'api-version': apiVersion });
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, v);
  const url = `${org}/${path}?${params.toString().replace(/%2F/gi, '/')}`;
  const res = await fetch(url, { headers: { Authorization: auth }, dispatcher });
  if (!res.ok) throw new Error(`${res.status} on ${path}`);
  return res.json();
}

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL }),
});

try {
  // --- 1. identity matching -------------------------------------------------
  const conn = await ado('_apis/connectionData', {}, '7.1-preview');
  const me = conn.authenticatedUser;
  console.log('connectionData.authenticatedUser.id :', me.id);
  console.log('connectionData displayName          :', me.providerDisplayName);

  const mine = await prisma.cachedPullRequest.findMany({
    where: { author: me.providerDisplayName },
    select: { pullRequestId: true, authorId: true, author: true },
    take: 5,
  });
  console.log('\ncached PRs whose author name matches me:', mine.length ? 'yes' : 'none');
  for (const pr of mine) console.log(`  !${pr.pullRequestId} authorId=${pr.authorId}`);
  if (mine.length) {
    console.log(
      '\n  ids equal?',
      mine[0].authorId === me.id ? 'YES - safe to filter on id' : 'NO - differs from connectionData',
    );
  }

  const total = await prisma.cachedPullRequest.count();
  const byAuthor = await prisma.cachedPullRequest.groupBy({
    by: ['author'],
    _count: { author: true },
    orderBy: { _count: { author: 'desc' } },
    take: 8,
  });
  console.log(`\ncached PRs total: ${total}`);
  console.log('top authors:');
  for (const row of byAuthor) console.log(`  ${row.author.padEnd(30)} ${row._count.author}`);

  // --- 2. work item states --------------------------------------------------
  const keys = await prisma.cachedPullRequest.findMany({
    where: { correlationKey: { not: null } },
    select: { correlationKey: true },
    distinct: ['correlationKey'],
    take: 200,
  });
  const ids = keys.map((k) => Number(k.correlationKey)).filter(Number.isFinite);
  console.log(`\ndistinct work item ids in cache (sampled): ${ids.length}`);

  const states = new Map();
  const types = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await ado(`${project}/_apis/wit/workitems`, {
      ids: batch.join(','),
      fields: 'System.State,System.WorkItemType',
      $expand: 'none',
      errorPolicy: 'omit',
    });
    for (const item of data.value ?? []) {
      if (!item?.fields) continue;
      const state = item.fields['System.State'] ?? '(none)';
      const type = item.fields['System.WorkItemType'] ?? '(none)';
      states.set(state, (states.get(state) ?? 0) + 1);
      types.set(type, (types.get(type) ?? 0) + 1);
    }
  }

  console.log('\nwork item States:');
  for (const [state, n] of [...states].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(state).padEnd(18)} ${n}`);
  }
  console.log('\nwork item Types:');
  for (const [type, n] of [...types].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(type).padEnd(18)} ${n}`);
  }
} catch (error) {
  console.error('PROBE FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
