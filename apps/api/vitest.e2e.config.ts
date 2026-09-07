import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * End-to-end suite. Separate from vitest.config.ts because these tests need a
 * live Postgres from docker-compose; keeping them out of `pnpm test` means the
 * unit suite stays runnable with no infrastructure.
 *
 * If you are here chasing a `read ECONNRESET` from one of these specs, read
 * this before reaching for a retry.
 *
 * Handed a server that is not already listening, supertest binds an ephemeral
 * port itself and closes it again when that one request ends — a full
 * listen/close cycle per request, and a different port each time. Sequentially
 * that is merely wasteful. But when a test fires a burst with `Promise.all`,
 * all of those requests are constructed in one tick: the first one binds the
 * port and owns the teardown, the other nine reuse the address. Whichever
 * response finishes first then closes the listening handle while its siblings
 * are still in flight (measured: 48 of 50 bursts). Sockets already accepted
 * survive the close; any whose accept has not yet run are reset by the kernel,
 * and the client reads that as ECONNRESET.
 *
 * On a developer machine the event loop is free and accepts land immediately,
 * so the window never opens — this reproduced zero times in 10 local runs and
 * failed in CI at 7ms into the test, far too fast for any timeout to be
 * involved. It is a race, not slowness, and not a stale keep-alive socket:
 * supertest pools no connections (`reusedSocket` is false on every request).
 *
 * The fix is in each spec's `beforeAll`: `app.listen(0, '127.0.0.1')` binds one
 * port for the file's lifetime, so supertest never listens and never closes,
 * and `app.close()` in `afterAll` tears it down once. That makes the failure
 * class impossible rather than papering over it — do not swap it for a test
 * retry, which would also swallow real regressions in the concurrency specs.
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
