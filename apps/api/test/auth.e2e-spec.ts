import { clerkMiddleware } from '@clerk/express';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';

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
    await app.init();
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
