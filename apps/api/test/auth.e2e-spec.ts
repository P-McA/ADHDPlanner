import { clerkMiddleware } from '@clerk/express';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { shouldMountClerk } from '../src/auth/clerk-mounting.js';

/**
 * Proves the auth wiring is actually *mounted*, which the tasks suite cannot:
 * it overrides ClerkAuthGuard, so it would still pass if the guard had been
 * left off the controllers entirely.
 *
 * Hermetic by construction. Outbound fetch is blocked for the lifetime of the
 * suite (see below), so every assertion here is about what the middleware can
 * decide *locally*: no verifiable credential means no `userId` means 401. The
 * result is identical on a runner with no DNS and no egress.
 *
 * What that leaves uncovered, deliberately: a *genuine* Clerk token being
 * accepted. That needs a live tenant and real keys, i.e. a smoke test run
 * against a deployed environment — not a unit of CI. See the Phase 1.2 note in
 * CLAUDE.md.
 */
describe('Auth wiring (e2e)', () => {
  let app: INestApplication;

  const http = (): Server => app.getHttpServer() as Server;

  /** Every URL Clerk's SDK tried to reach while this suite ran. */
  const outbound: string[] = [];
  let realFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    // Simulates an offline runner. @clerk/backend talks to Clerk over fetch, so
    // trapping it here is the boundary mock: if any assertion below depended on
    // Clerk confirming a token were invalid, it would fail rather than quietly
    // pass on a machine that happens to have internet. Supertest drives the app
    // over a loopback socket via node:http, so it is unaffected.
    realFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      outbound.push(url);
      return Promise.reject(new Error(`e2e: outbound network is blocked (${url})`));
    };

    // The SDK announces it collects telemetry from development instances. It
    // has never shown up in `outbound` below, but an opt-out is cheaper than
    // relying on that staying true.
    process.env.CLERK_TELEMETRY_DISABLED = '1';

    // clerkMiddleware() reads these when it is constructed, so they must be set
    // first. Deliberately fake: a real key would not change any assertion here,
    // it would only invite the suite to depend on a live tenant.
    process.env.CLERK_SECRET_KEY ||= 'sk_test_0000000000000000000000000000000000000000';
    process.env.CLERK_PUBLISHABLE_KEY ||= 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors main.ts: middleware first, so the guard has something to read.
    app.use(clerkMiddleware());
    // Listen once for the whole file. Left unlistened, supertest starts and
    // closes the server around every single request; see vitest.e2e.config.ts
    // for why that surfaces as `read ECONNRESET` under a concurrent burst.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await app.close();
  });

  it('rejects anonymous access to GET /me', async () => {
    const res = await request(http()).get('/me');

    expect(res.status).toBe(401);
  });

  it('rejects anonymous access to GET /me/stats', async () => {
    // Gamification totals are per-user; an unguarded stats route would be the
    // easiest place to leak one user's activity to another.
    const res = await request(http()).get('/me/stats');

    expect(res.status).toBe(401);
  });

  it('rejects anonymous access to the task routes', async () => {
    const paths: [string, () => request.Test][] = [
      ['list', () => request(http()).get('/tasks')],
      ['create', () => request(http()).post('/tasks').send({ title: 'x' })],
      ['read', () => request(http()).get('/tasks/11111111-1111-1111-1111-111111111111')],
      [
        'update',
        () =>
          request(http())
            .patch('/tasks/11111111-1111-1111-1111-111111111111')
            .send({ title: 'x' }),
      ],
      ['delete', () => request(http()).delete('/tasks/11111111-1111-1111-1111-111111111111')],
    ];

    for (const [name, send] of paths) {
      const res = await send();
      expect(res.status, `${name} must not be anonymously reachable`).toBe(401);
    }
  });

  it('rejects a garbage bearer token without asking Clerk', async () => {
    // `not-a-token` is not even a well-formed JWT, so the middleware can reject
    // it from structure alone. This asserts that specifically: a 401 that
    // arrived without egress, rather than a 401 that happened to come back from
    // Clerk's API.
    const before = outbound.length;

    const res = await request(http()).get('/tasks').set('Authorization', 'Bearer not-a-token');

    expect(res.status).toBe(401);
    expect(outbound.slice(before)).toEqual([]);
  });

  it('leaves GET /health public', async () => {
    // clerkMiddleware() must populate the request without rejecting anonymous
    // callers; if it rejected them, this would be a 401 instead.
    const res = await request(http()).get('/health');

    expect([200, 503]).toContain(res.status);
  });

  it('reached no external network at all', () => {
    // The CI contract for this file: identical result regardless of runner DNS.
    // If a future Clerk version starts verifying over the wire, this fails and
    // the boundary has to be re-mocked deliberately rather than by accident.
    expect(outbound).toEqual([]);
  });
});

/**
 * The server a developer gets on `pnpm dev:api` with no Clerk account.
 *
 * Until this was fixed it answered **500 to everything**, by two independent
 * routes, and neither was visible from the suite above because that one
 * supplies placeholder keys and mounts the middleware:
 *
 * 1. `main.ts` mounted `clerkMiddleware()` whenever the dev bypass was *off*,
 *    key or no key, and Clerk with no publishable key calls `next(err)` on
 *    every request — before any route or guard — so even `GET /health` was a
 *    500. (Verified directly against @clerk/express: the error is
 *    "Publishable key is missing".)
 * 2. `ClerkAuthGuard` let `getAuth`'s throw escape unless the bypass was armed,
 *    and `getAuth` throws rather than reporting an empty session when the
 *    middleware was never mounted.
 *
 * So the app here is assembled the way `shouldMountClerk() === false` says it
 * should be — no middleware — and the bypass is disarmed, which is the exact
 * configuration that used to fail. 401 is the correct answer: the request
 * genuinely carries no identity this server can verify.
 */
describe('Auth wiring with no Clerk keys (e2e)', () => {
  let app: INestApplication;
  let loggedError: MockInstance<Logger['error']>;

  const http = (): Server => app.getHttpServer() as Server;

  const saved: Record<string, string | undefined> = {};
  const unset = (name: string): void => {
    saved[name] = process.env[name];
    delete process.env[name];
  };

  beforeAll(async () => {
    // Files share a process (`fileParallelism: false`), so these are restored
    // in afterAll — an unset Clerk key left behind is a global change.
    unset('CLERK_PUBLISHABLE_KEY');
    unset('CLERK_SECRET_KEY');
    unset('DEV_AUTH_BYPASS');

    // The premise of the whole block, asserted rather than assumed: with no
    // key, bootstrap does not mount Clerk. If this ever flips, the app below
    // stops resembling the server it is standing in for.
    expect(shouldMountClerk()).toBe(false);

    // The guard logs the misconfiguration at error level on every request here,
    // which is the point — but a passing run should not print stack traces.
    loggedError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    // Deliberately no `app.use(clerkMiddleware())`. That is the whole scenario.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    loggedError.mockRestore();
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
    await app.close();
  });

  it('answers 401, not 500, on a guarded route', async () => {
    const res = await request(http()).get('/tasks');

    expect(res.status).toBe(401);
  });

  it('answers 401 on every guarded route, not just the listing one', async () => {
    for (const path of ['/me', '/me/stats', '/tasks', '/ingestion']) {
      const res = await request(http()).get(path);

      expect(res.status, `${path} must be 401 on a keyless server`).toBe(401);
    }
  });

  it('keeps GET /health reachable, which the mounted-middleware bug did not', async () => {
    // The 500 this replaces reached here too: Clerk rejected the request before
    // routing, so the public health probe went down with everything else — and
    // a health check that reports the server unhealthy because *auth* is
    // unconfigured tells an operator the wrong thing.
    const res = await request(http()).get('/health');

    expect([200, 503]).toContain(res.status);
  });

  it('is not merely a slower 500: the same app answers 200 on a public route', async () => {
    // Guards against the block passing because the app is broken in some other
    // way. 401 above and 200 here mean routing works and only auth is absent.
    const res = await request(http()).get('/health');

    expect(res.status).not.toBe(500);
  });

  it('tells the operator why, instead of only telling the caller', async () => {
    loggedError.mockClear();

    await request(http()).get('/tasks');

    const messages = loggedError.mock.calls.map(([message]) => String(message));

    // Deliberately the guard's own wording, not the word "clerkMiddleware":
    // Nest logs the stack of an *unhandled* error too, and that stack also says
    // "clerkMiddleware". Asserting on that would have passed on the 500 this
    // test exists to rule out — which is how the first version of it behaved
    // under the mutation run, and why the assertion is this specific.
    expect(messages.some((message) => message.includes('treating the request as unauthenticated'))).toBe(
      true,
    );
  });
});

/*
 * There is deliberately no suite here mounting Clerk *without* a key, though
 * that 500-on-every-route behaviour is the whole reason `shouldMountClerk()`
 * exists. It cannot be reproduced in this process and a test that tried would
 * be a green test asserting nothing.
 *
 * `@clerk/express` caches its client the first time one is built successfully,
 * process-wide. The suites above build one with placeholder keys, and e2e files
 * share a process (`fileParallelism: false`), so a later `clerkMiddleware()`
 * constructed with the keys deleted goes on serving requests happily — it was
 * asserted at 500 here first, and came back 200. Reproduced outside Vitest:
 * one middleware built with keys then a second built without, in one process,
 * both pass; in a fresh process with no keys ever set, the first one rejects
 * every request with "Publishable key is missing".
 *
 * So that claim is evidence from a probe, not a check, and CLAUDE.md says so.
 * Anything that needs to observe a misconfigured Clerk has to spawn a clean
 * process to do it.
 */
