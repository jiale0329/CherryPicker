/**
 * Confirms the Prisma 7 driver-adapter wiring actually opens the SQLite file
 * and that the schema was pushed. Typechecking cannot catch a bad adapter.
 */
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const url = process.env.DATABASE_URL ?? 'file:./prisma/dev.db';
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });

try {
  const counts = {
    appConfig: await prisma.appConfig.count(),
    trackedRepository: await prisma.trackedRepository.count(),
    releaseBranchConfig: await prisma.releaseBranchConfig.count(),
    backportJob: await prisma.backportJob.count(),
    cachedPullRequest: await prisma.cachedPullRequest.count(),
    pullRequestLink: await prisma.pullRequestLink.count(),
  };
  console.log('connected to', url);
  for (const [table, n] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(22)} ${n}`);
  }

  // Round-trip a write to prove the adapter is not read-only.
  const probe = await prisma.releaseBranchConfig.create({
    data: { branchName: '__smoke__', versionLabel: '0.0', stageLabel: 'TEST', sortOrder: 999 },
  });
  await prisma.releaseBranchConfig.delete({ where: { id: probe.id } });
  console.log('write round-trip OK');
} catch (error) {
  console.error('DB SMOKE FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
