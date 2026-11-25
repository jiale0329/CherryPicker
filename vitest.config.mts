import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Git integration tests spawn real git in temporary repositories.
    testTimeout: 60_000,
    env: {
      // The git layer logs every invocation at debug, which buries test output.
      LOG_LEVEL: 'warn',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
});
