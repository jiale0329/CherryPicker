/**
 * Compares what a work item links to against what the branch-scoped sync sees.
 *
 * Answers whether a work-item-first fetch would surface more than the current
 * approach, which only reads pull requests targeting the configured releases.
 */
import { readFileSync } from 'node:fs';

import { config as loadEnv } from 'dotenv';
import { Agent } from 'undici';

loadEnv({ path: '.env.local', quiet: true });

const workItemId = process.argv[2] ?? '1444759';
const TRACKED = new Set([
  'release/26.2.1.PRE',
  'release/26.2.1.0',
  'release/26.5.1.PRE',
  'release/26.5.1.0',
  'release/26.8.1.PRE',
  'release/26.8.1.0',
]);

const ca = readFileSync(process.env.ADO_CA_BUNDLE, 'utf8');
const dispatcher = new Agent({ connect: { ca } });
const auth = 'Basic ' + Buffer.from(':' + process.env.ADO_PAT).toString('base64');
const root = `${process.env.ADO_ORG_URL}/${process.env.ADO_PROJECT}/_apis`;

async function get(url) {
  const res = await fetch(url, { headers: { Authorization: auth }, dispatcher });
  if (!res.ok) return null;
  return res.json();
}

const wi = await get(`${root}/wit/workitems/${workItemId}?$expand=relations&api-version=7.1`);
if (!wi) {
  console.error('could not read work item', workItemId);
  process.exit(1);
}

console.log(`work item ${workItemId}: ${wi.fields['System.Title']}`);
console.log(`state=${wi.fields['System.State']}  type=${wi.fields['System.WorkItemType']}\n`);

const links = (wi.relations ?? []).filter(
  (rel) => rel.rel === 'ArtifactLink' && String(rel.url).includes('PullRequestId'),
);

const rows = [];
for (const rel of links) {
  const parts = decodeURIComponent(String(rel.url).replace(/.*PullRequestId\//, '')).split('/');
  const [, repoId, prId] = parts;
  const pr = await get(`${root}/git/repositories/${repoId}/pullrequests/${prId}?api-version=7.1`);
  if (!pr) continue;
  rows.push({
    repo: pr.repository?.name ?? repoId,
    pr: Number(prId),
    target: String(pr.targetRefName).replace(/^refs\/heads\//, ''),
    status: pr.status,
  });
}

rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.target.localeCompare(b.target));

console.log('REPO                         PR       TARGET BRANCH          STATUS    TRACKED');
console.log('-'.repeat(84));
for (const row of rows) {
  console.log(
    `${row.repo.padEnd(28)} ${String(row.pr).padEnd(8)} ${row.target.padEnd(22)} ${row.status.padEnd(9)} ${TRACKED.has(row.target) ? 'yes' : '-'
    }`,
  );
}

const tracked = rows.filter((row) => TRACKED.has(row.target));
console.log('');
console.log(`PR links on the work item     : ${links.length}`);
console.log(`resolved                      : ${rows.length}`);
console.log(`distinct repositories         : ${new Set(rows.map((r) => r.repo)).size}`);
console.log(`distinct target branches      : ${new Set(rows.map((r) => r.target)).size}`);
console.log(`within the tracked 6 releases : ${tracked.length}`);
