import path from 'node:path';

import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// The Prisma CLI is not Next, so .env.local is not loaded for us.
loadEnv({ path: '.env.local', quiet: true });
loadEnv({ quiet: true });

/**
 * Prisma 7 configuration.
 *
 * Prisma 7 no longer allows the connection URL in schema.prisma, so the CLI
 * reads it from here. The driver adapter is a runtime concern and belongs on
 * the PrismaClient constructor instead - see src/lib/prisma/client.ts.
 */
const databaseUrl = process.env.DATABASE_URL ?? 'file:./prisma/dev.db';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  // Required by migration and introspection commands (`db push`, `migrate`).
  datasource: {
    url: databaseUrl,
  },
});
