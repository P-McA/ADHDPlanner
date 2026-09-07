import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * End-to-end suite. Separate from vitest.config.ts because these tests need a
 * live Postgres from docker-compose; keeping them out of `pnpm test` means the
 * unit suite stays runnable with no infrastructure.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['test/load-env.ts'],
    // The suites share one database and delete rows between tests, so running
    // files concurrently would have them clearing each other's fixtures.
    fileParallelism: false,
    // Nest bootstraps a real app and Prisma opens a pool; the default 5s is
    // tight for the first file.
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
