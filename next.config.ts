import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /*
   * Cache Components (enabled by create-next-app's defaults) is deliberately
   * off. This dashboard reports live Azure DevOps state, and its correctness
   * claim is that a cell marked Merged really is merged. An implicit caching
   * layer between the route handler and the UI would reintroduce exactly the
   * stale-status problem the tool exists to solve, and it forbids the
   * `dynamic = 'force-dynamic'` the API routes rely on.
   *
   * Freshness is instead explicit: SQLite caches ADO reads, `syncedAt` is shown
   * in the UI, and Refresh re-reads from ADO.
   */
  cacheComponents: false,

  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },

  // better-sqlite3 is a native module and must not be bundled.
  serverExternalPackages: ['better-sqlite3', '@prisma/adapter-better-sqlite3'],
};

export default nextConfig;
