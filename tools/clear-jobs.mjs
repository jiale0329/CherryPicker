/**
 * Clears backport job history.
 *
 * Used to remove rows written by dry runs before dry runs stopped being
 * persisted. Safe: these rows record local rehearsals, never anything pushed.
 */
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL }),
});

try {
  const withPr = await prisma.backportJob.count({ where: { targetPrId: { not: null } } });
  if (withPr > 0) {
    console.error(
      `Refusing to clear: ${withPr} job(s) reference a created pull request. ` +
        'Those are real history.',
    );
    process.exitCode = 1;
  } else {
    const logs = await prisma.backportJobLog.deleteMany({});
    const jobs = await prisma.backportJob.deleteMany({});
    console.log(`deleted ${jobs.count} job(s) and ${logs.count} log entr(ies)`);
  }
} finally {
  await prisma.$disconnect();
}
