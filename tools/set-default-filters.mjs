/**
 * One-off: turn on the "only my pull requests" default for config rows that
 * were created before the flag existed. New installs get it from the schema
 * default, so this is only needed on an already-seeded database.
 */
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL }),
});

try {
  const result = await prisma.appConfig.updateMany({ data: { defaultOnlyMine: true } });
  const config = await prisma.appConfig.findFirst();
  console.log('config rows updated   :', result.count);
  console.log('defaultOnlyMine       :', config?.defaultOnlyMine);
  console.log('adoUserId             :', config?.adoUserId ?? '(not yet backfilled)');
  console.log('excludedWorkItemStates:', config?.excludedWorkItemStatesJson);
} finally {
  await prisma.$disconnect();
}
