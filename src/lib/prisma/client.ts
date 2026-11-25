import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';

import { getServerEnv } from '@/lib/config/env';

/**
 * Prisma client singleton.
 *
 * Construction is lazy, behind a Proxy, for two reasons:
 *
 *  - Importing a module should not open a database connection or demand
 *    configuration. Before this was lazy, a pure unit test that imported any
 *    module transitively touching prisma failed with a config error.
 *  - Next's dev server re-evaluates modules on hot reload, which would
 *    otherwise leak a SQLite connection per edit. Caching on globalThis
 *    survives reload.
 *
 * Prisma 7 requires a driver adapter rather than a datasource URL in the schema.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function create(): PrismaClient {
  const env = getServerEnv();
  const client = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: env.DATABASE_URL }),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = client;
  return client;
}

function resolve(): PrismaClient {
  return globalForPrisma.prisma ?? create();
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    return Reflect.get(resolve() as object, property, receiver);
  },
  has(_target, property) {
    return Reflect.has(resolve() as object, property);
  },
});
