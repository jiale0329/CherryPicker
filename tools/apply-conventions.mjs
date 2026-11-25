/**
 * Applies the team's branch and title conventions to an existing config row.
 *
 * Prisma schema defaults only apply when a row is created, so a database that
 * was seeded before the conventions were corrected keeps the old templates.
 */
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });

const BRANCH_TEMPLATE = 'hotfix/{workItemId}-{slug}-on-release-{targetSlug}';
const TITLE_TEMPLATE = 'Cherry-Pick | {repo} | {targetVersion} | {originalTitle}';

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL }),
});

try {
  const result = await prisma.appConfig.updateMany({
    data: {
      backportBranchTemplate: BRANCH_TEMPLATE,
      prTitleTemplate: TITLE_TEMPLATE,
    },
  });

  const config = await prisma.appConfig.findFirst();
  console.log('rows updated   :', result.count);
  console.log('branch template:', config?.backportBranchTemplate);
  console.log('title template :', config?.prTitleTemplate);
} finally {
  await prisma.$disconnect();
}
