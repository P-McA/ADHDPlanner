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
 * Nothing here needs real Clerk credentials. A syntactically valid but bogus
 * secret key is enough, because every assertion is about the *unauthenticated*
 * path: no session means no `userId` means 401. Verifying a genuine token is
 * the one thing this suite cannot cover.
 */
describe('Auth wiring (e2e)', () => {
  let app: INestApplication;

  const http = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    // clerkMiddleware() reads these when it is constructed, so they must be set
    // first. Deliberately fake: a real key would make this suite depend on a
    // live Clerk tenant.
    process.env.CLERK_SECRET_KEY ||= 'sk_test_0000000000000000000000000000000000000000';
    process.env.CLERK_PUBLISHABLE_KEY ||= 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication();
    // Mirrors main.ts: middleware first, so the guard has something to read.
    app.use(clerkMiddleware());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects anonymous access to GET /me', async () => {
    const res = await request(http()).get('/me');

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

  it('rejects a garbage bearer token rather than accepting it', async () => {
    const res = await request(http()).get('/tasks').set('Authorization', 'Bearer not-a-token');

    expect(res.status).toBe(401);
  });

  it('leaves GET /health public', async () => {
    // clerkMiddleware() must populate the request without rejecting anonymous
    // callers; if it rejected them, this would be a 401 instead.
    const res = await request(http()).get('/health');

    expect([200, 503]).toContain(res.status);
  });
});
