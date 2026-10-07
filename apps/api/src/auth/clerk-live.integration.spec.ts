import { clerkMiddleware } from '@clerk/express';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Deployment checklist item 1: a *genuine* Clerk session token is ACCEPTED.
 *
 * Every other auth check in this repo is a rejection check, deliberately
 * hermetic. This is the other direction, and it can only be proved against a
 * live Clerk instance: it creates a throwaway user through Clerk's Backend
 * API, mints a real session token for it, and calls GET /me through the real
 * `clerkMiddleware()` and the unmocked `ClerkAuthGuard` — no guard override, no
 * dev header, `DEV_AUTH_BYPASS` disarmed. Then it deletes the user.
 *
 * Opt-in twice over, because it writes to a real tenant:
 * - `CLERK_LIVE_SMOKE=1` must be set, so `pnpm test` never runs it; and
 * - the secret key must be a **`sk_test_`** (development instance) key, so it
 *   can never create users in a production instance.
 *
 *   CLERK_LIVE_SMOKE=1 pnpm --filter @adhd/api exec vitest run src/auth/clerk-live.integration.spec.ts
 *
 * Needs the compose services up (it provisions the local user row).
 */

if (process.env.CLERK_LIVE_SMOKE === '1') {
  try {
    process.loadEnvFile();
  } catch {
    // No .env: the gate below reports why it skipped.
  }
}

const secret = process.env.CLERK_SECRET_KEY ?? '';
const live = process.env.CLERK_LIVE_SMOKE === '1' && secret.startsWith('sk_test_');

const CLERK_API = 'https://api.clerk.com/v1';

async function clerk<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${CLERK_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Clerk ${method} ${path} → ${String(response.status)}: ${text}`);
  }

  return (text === '' ? {} : JSON.parse(text)) as T;
}

describe.skipIf(!live)('a genuine Clerk session against the real guard (live)', () => {
  let app: INestApplication | undefined;
  let clerkUserId = '';
  let token = '';
  const email = `planner-smoke-${Date.now().toString(36)}+clerk_test@example.com`;

  beforeAll(async () => {
    // Nothing but the real path may satisfy the guard.
    delete process.env.DEV_AUTH_BYPASS;
    process.env.INGESTION_WORKER_DISABLED = 'true';
    process.env.REMINDER_WORKER_DISABLED = 'true';

    const user = await clerk<{ id: string }>('POST', '/users', {
      email_address: [email],
      password: `Smoke-${crypto.randomUUID()}`,
      skip_password_checks: true,
    });
    clerkUserId = user.id;

    const session = await clerk<{ id: string }>('POST', '/sessions', { user_id: clerkUserId });
    ({ jwt: token } = await clerk<{ jwt: string }>('POST', `/sessions/${session.id}/tokens`));

    const { AppModule } = await import('../app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Mounted exactly as main.ts does when shouldMountClerk() is true.
    app.use(clerkMiddleware());
    await app.listen(0, '127.0.0.1');
  }, 60_000);

  afterAll(async () => {
    if (app !== undefined) {
      const { PrismaService } = await import('../prisma/prisma.service.js');
      await app.get(PrismaService).user.deleteMany({ where: { clerkId: clerkUserId } });
      await app.close();
    }
    if (clerkUserId !== '') await clerk('DELETE', `/users/${clerkUserId}`);
  }, 60_000);

  const http = (): Server => app?.getHttpServer() as Server;

  it('accepts a real session token and provisions that Clerk user', async () => {
    const res = await request(http()).get('/me').set('authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ clerkId: clerkUserId, email });
  });

  it('still refuses the same token once tampered with', async () => {
    const tampered = `${token.slice(0, -4)}AAAA`;

    const res = await request(http()).get('/me').set('authorization', `Bearer ${tampered}`);

    expect(res.status).toBe(401);
  });
});
