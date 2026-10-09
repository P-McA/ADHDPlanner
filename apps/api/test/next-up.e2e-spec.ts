import type { RankedTaskPage, Task } from '@adhd/shared';
import { type ExecutionContext, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * "Next up", end to end: GET /tasks/next against real Postgres.
 *
 * What is pinned here is what only the database can show — which rows are in
 * the ranked set at all (open, top-level, confirmed, the caller's), that the
 * score reads the user's estimate and never the suggested one, and that the
 * keyset cursor walks the whole order with no overlap and no gap. The scoring
 * arithmetic itself is `packages/shared/src/priority.test.ts`; the time-zone
 * resolution, which needs a fixed clock, is the service unit spec.
 *
 * Users here are on the default UTC zone, and every due date is noon UTC on
 * a day counted from the real today, so nothing straddles a midnight.
 */
describe('Next up (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userA: string;
  let userB: string;

  const suffix = Date.now().toString(36);
  const http = (): Server => app.getHttpServer() as Server;
  const json = <T>(res: Response): T => res.body as T;
  const asUser = (userId: string): Record<string, string> => ({ 'x-test-user': userId });

  /** Noon UTC, `days` from today. */
  const noon = (days: number): string => {
    const today = new Date().toISOString().slice(0, 10);
    const at = new Date(`${today}T12:00:00.000Z`);

    at.setUTCDate(at.getUTCDate() + days);

    return at.toISOString();
  };

  async function task(userId: string, body: Record<string, unknown>): Promise<Task> {
    const res = await request(http()).post('/tasks').set(asUser(userId)).send(body).expect(201);

    return json<Task>(res);
  }

  const next = (userId: string, query: Record<string, string | number> = {}) =>
    request(http()).get('/tasks/next').query(query).set(asUser(userId));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ClerkAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext): boolean => {
          const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
          const id = req.headers['x-test-user'];

          if (typeof id !== 'string') return false;

          req.appUser = { id, clerkId: `clerk_${id}` };

          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');

    prisma = app.get(PrismaService);

    const [a, b] = await Promise.all([
      prisma.user.create({
        data: { clerkId: `clerk_next_a_${suffix}`, email: `next_a_${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { clerkId: `clerk_next_b_${suffix}`, email: `next_b_${suffix}@test.local` },
      }),
    ]);
    userA = a.id;
    userB = b.id;
  });

  afterAll(async () => {
    await prisma.xpEvent.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await app.close();
  });

  beforeEach(async () => {
    await prisma.task.deleteMany({ where: { userId: { in: [userA, userB] } } });
  });

  it('puts the open tasks in urgency order, each with its reasons', async () => {
    const someday = await task(userA, { title: 'Someday' });
    const overdue = await task(userA, { title: 'Overdue', dueAt: noon(-3) });
    const quick = await task(userA, { title: 'Quick', estimateMinutes: 5 });
    const today = await task(userA, { title: 'Today', dueAt: noon(0), manualPriority: 'high' });

    const res = await next(userA).expect(200);
    const page = json<RankedTaskPage>(res);

    expect(page.items.map((item) => item.id)).toEqual([overdue.id, today.id, quick.id, someday.id]);
    expect(page.items[1]!.rank.reasons).toEqual(['Due today', 'High priority']);
    expect(page.items[2]!.rank.reasons).toEqual(['Quick win · ~5 min']);
    expect(page.items[3]!.rank.reasons).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('leaves out finished, binned, unconfirmed and step tasks, and other people’s', async () => {
    const open = await task(userA, { title: 'Open' });
    const done = await task(userA, { title: 'Done' });
    const binned = await task(userA, { title: 'Binned' });
    for (const [id, status] of [
      [done.id, 'done'],
      [binned.id, 'archived'],
    ] as const) {
      await request(http()).patch(`/tasks/${id}`).set(asUser(userA)).send({ status }).expect(200);
    }
    await prisma.task.create({
      data: { userId: userA, title: 'Draft', source: 'ai_suggested', confirmedAt: null },
    });
    await prisma.task.create({
      data: { userId: userA, title: 'A step', parentTaskId: open.id, stepOrder: 0 },
    });
    await task(userB, { title: 'Theirs', dueAt: noon(-5) });

    const res = await next(userA).expect(200);

    expect(json<RankedTaskPage>(res).items.map((item) => item.title)).toEqual(['Open']);
  });

  it('keeps an in-progress task in the list', async () => {
    const started = await task(userA, { title: 'Started' });
    await request(http())
      .patch(`/tasks/${started.id}`)
      .set(asUser(userA))
      .send({ status: 'in_progress' })
      .expect(200);

    const res = await next(userA).expect(200);

    expect(json<RankedTaskPage>(res).items.map((item) => item.id)).toEqual([started.id]);
  });

  it('ranks by the user’s own estimate, never by a suggestion nobody accepted', async () => {
    // A model suggestion is a draft; it must not move the user's day.
    const suggestedOnly = await task(userA, { title: 'Suggested only' });
    await prisma.task.update({
      where: { id: suggestedOnly.id },
      data: { suggestedEstimateMinutes: 5 },
    });

    const res = await next(userA).expect(200);
    const item = json<RankedTaskPage>(res).items[0]!;

    expect(item.rank.reasons).toEqual([]);
  });

  it('walks the whole order a page at a time, with no task twice and none missed', async () => {
    const created = await Promise.all(
      [-2, -1, 0, 1, 3, 10, null].map((days, i) =>
        task(userA, { title: `T${String(i)}`, ...(days === null ? {} : { dueAt: noon(days) }) }),
      ),
    );
    const whole = json<RankedTaskPage>(await next(userA).expect(200)).items.map((item) => item.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: RankedTaskPage = json<RankedTaskPage>(
        await next(userA, { limit: 3, ...(cursor === null ? {} : { cursor }) }).expect(200),
      );

      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);

    expect(seen).toEqual(whole);
    expect(new Set(seen).size).toBe(created.length);
    expect(pages).toBe(3);
  });

  it('refuses a cursor it did not issue, and a limit out of range', async () => {
    await next(userA, { cursor: 'not-a-cursor' }).expect(400);
    await next(userA, { limit: 0 }).expect(400);
    await next(userA, { limit: 101 }).expect(400);
  });

  it('is not mistaken for a task id', async () => {
    // Declared before GET /tasks/:id; otherwise ParseUUIDPipe would 400 "next".
    await next(userA).expect(200);
  });
});
