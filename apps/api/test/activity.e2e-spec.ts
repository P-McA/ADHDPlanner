import type { ActivityMetrics, Task, User } from '@adhd/shared';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { localCalendarDate, previousCalendarDate, toDateColumn } from '../src/common/calendar.js';
import { mondayOf } from '../src/notifications/weekly-digest.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Tracking modes, the start signal, the performance ledger and GET /me/activity
 * against the real Postgres.
 *
 * The guard is stubbed as in the other suites; everything below it — the
 * conditional start write, the completion transaction, the unique event key,
 * the DATE column — is real, which is what makes the idempotency cases mean
 * something.
 */
describe('Activity metrics (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userA: string;
  let userB: string;

  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  type HttpTest = ReturnType<ReturnType<typeof request>['patch']>;
  const http = (): Server => app.getHttpServer() as Server;
  const json = <T>(res: Response): T => res.body as T;
  const asUser = (userId: string): Record<string, string> => ({ 'x-test-user': userId });

  const createTask = (userId: string, body: Record<string, unknown> = {}): HttpTest =>
    request(http())
      .post('/tasks')
      .set(asUser(userId))
      .send({ title: 'seed', ...body });

  const seedTask = async (userId: string, body: Record<string, unknown> = {}): Promise<string> => {
    const res = await createTask(userId, body);
    expect(res.status).toBe(201);
    return json<Task>(res).id;
  };

  const patchTask = (userId: string, id: string, body: Record<string, unknown>): HttpTest =>
    request(http()).patch(`/tasks/${id}`).set(asUser(userId)).send(body);

  const patchMe = (userId: string, body: Record<string, unknown>): HttpTest =>
    request(http()).patch('/me').set(asUser(userId)).send(body);

  const activity = (userId: string): HttpTest =>
    request(http()).get('/me/activity').set(asUser(userId));

  const eventsFor = (taskId: string) => prisma.performanceEvent.findMany({ where: { taskId } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ClerkAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContextLike): boolean => {
          const req = context.switchToHttp().getRequest();
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
        data: { clerkId: `clerk_act_a_${suffix}`, email: `act_a_${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { clerkId: `clerk_act_b_${suffix}`, email: `act_b_${suffix}@test.local` },
      }),
    ]);
    userA = a.id;
    userB = b.id;
  });

  afterAll(async () => {
    await prisma.performanceEvent.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.task.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await app.close();
  });

  beforeEach(async () => {
    await prisma.performanceEvent.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.xpEvent.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.streak.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.task.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.user.updateMany({
      where: { id: { in: [userA, userB] } },
      data: { timezone: 'UTC', trackingMode: 'metrics', showElo: false },
    });
  });

  describe('profile settings', () => {
    it('defaults to metrics with the number hidden', async () => {
      const me = json<User>(await request(http()).get('/me').set(asUser(userA)).expect(200));

      expect(me.trackingMode).toBe('metrics');
      expect(me.showElo).toBe(false);
    });

    it('changes one field without re-sending the zone', async () => {
      const res = await patchMe(userA, { showElo: true }).expect(200);

      expect(json<User>(res).showElo).toBe(true);
      expect(json<User>(res).timezone).toBe('UTC');
    });

    it('accepts an empty body as a no-op', async () => {
      await patchMe(userA, {}).expect(200);
    });

    it('switches the mode and persists it', async () => {
      const res = await patchMe(userA, { trackingMode: 'xp' }).expect(200);

      expect(json<User>(res).trackingMode).toBe('xp');
    });

    it('refuses a mode it does not know', async () => {
      await patchMe(userA, { trackingMode: 'leaderboard' }).expect(400);
    });

    it('still validates a zone when one is sent', async () => {
      await patchMe(userA, { timezone: 'Mars/Olympus_Mons' }).expect(400);
    });

    it.each(['timezone', 'trackingMode', 'showElo'])(
      'refuses an explicit null %s with 400 rather than a 500',
      async (field) => {
        await patchMe(userA, { [field]: null }).expect(400);
      },
    );

    it('keeps XP accruing while in metrics mode', async () => {
      const id = await seedTask(userA);
      await patchTask(userA, id, { status: 'done' }).expect(200);

      const stats = await request(http()).get('/me/stats').set(asUser(userA)).expect(200);
      expect(json<{ totalXp: number }>(stats).totalXp).toBeGreaterThan(0);
    });
  });

  describe('start signal', () => {
    it('stamps the first start and does not move it on a second', async () => {
      const id = await seedTask(userA);

      const first = json<Task>(await patchTask(userA, id, { status: 'in_progress' }).expect(200));
      expect(first.startedAt).not.toBeNull();

      const second = json<Task>(await patchTask(userA, id, { status: 'in_progress' }).expect(200));
      expect(second.startedAt).toBe(first.startedAt);
    });

    it('clears the start when the task is reopened', async () => {
      const id = await seedTask(userA);
      await patchTask(userA, id, { status: 'in_progress' }).expect(200);
      await patchTask(userA, id, { status: 'done' }).expect(200);

      const reopened = json<Task>(await patchTask(userA, id, { status: 'pending' }).expect(200));
      expect(reopened.startedAt).toBeNull();
    });
  });

  describe('performance ledger', () => {
    it('writes exactly one event for a completion', async () => {
      const id = await seedTask(userA, { estimateMinutes: 15 });

      await patchTask(userA, id, { status: 'done' }).expect(200);

      const events = await eventsFor(id);
      expect(events).toHaveLength(1);
      expect(events[0]!.userId).toBe(userA);
      expect(typeof events[0]!.score).toBe('number');
    });

    it('does not double-count a reopen and re-complete on the same day', async () => {
      const id = await seedTask(userA);

      await patchTask(userA, id, { status: 'done' }).expect(200);
      await patchTask(userA, id, { status: 'pending' }).expect(200);
      await patchTask(userA, id, { status: 'done' }).expect(200);

      expect(await eventsFor(id)).toHaveLength(1);
    });

    it('survives an unusable stored zone instead of aborting the completion', async () => {
      await prisma.user.update({ where: { id: userA }, data: { timezone: 'Not/AZone' } });
      const id = await seedTask(userA);

      await patchTask(userA, id, { status: 'done' }).expect(200);

      const events = await eventsFor(id);
      expect(events).toHaveLength(1);
      expect(events[0]!.localDate.toISOString().slice(0, 10)).toBe(
        localCalendarDate(new Date(), 'UTC'),
      );
    });
  });

  describe('GET /me/activity', () => {
    it('counts completions and excludes drafts and archived work from pending', async () => {
      const done = await seedTask(userA);
      await patchTask(userA, done, { status: 'done' }).expect(200);

      await seedTask(userA);
      await prisma.task.create({
        data: {
          userId: userA,
          title: 'draft',
          source: 'ai_suggested',
          confirmedAt: null,
        },
      });
      await prisma.task.create({
        data: { userId: userA, title: 'archived', status: 'archived' },
      });

      const body = json<ActivityMetrics>(await activity(userA).expect(200));

      expect(body.counts.completedToday).toBe(1);
      expect(body.pending).toBe(1);
    });

    it('reports no-data on a fresh account rather than a confident comparison', async () => {
      const body = json<ActivityMetrics>(await activity(userA).expect(200));

      expect(body.day).toEqual({ status: 'no-data' });
      expect(body.week).toEqual({ status: 'no-data' });
      expect(body.month).toEqual({ status: 'no-data' });
    });

    it('compares today against a day-weighted baseline once there is enough history', async () => {
      const today = localCalendarDate(new Date(), 'UTC');

      // One busy day (three events at 300) and two quiet days (100 each).
      // Day-mean baseline is (300 + 100 + 100) / 3 = 166; a raw-event mean
      // would be 150, so the assertion distinguishes the two.
      await prisma.performanceEvent.createMany({
        data: [300, 300, 300].map((score) => ({
          userId: userA,
          localDate: toDateColumn(previousCalendarDate(today)),
          complexity: 1,
          speedFactor: 1,
          score,
        })),
      });
      for (let back = 2; back <= 3; back += 1) {
        await prisma.performanceEvent.create({
          data: {
            userId: userA,
            localDate: toDateColumn(shift(today, -back)),
            complexity: 1,
            speedFactor: 1,
            score: 100,
          },
        });
      }

      const id = await seedTask(userA, { estimateMinutes: 240 });
      await patchTask(userA, id, { status: 'done' }).expect(200);

      const body = json<ActivityMetrics>(await activity(userA).expect(200));

      expect(body.day.status).toBe('ok');
      expect(body.day).toMatchObject({ direction: 'above', baseline: 167 });
    });

    it('withholds a week comparison until three days of the week have data', async () => {
      const today = localCalendarDate(new Date(), 'UTC');
      const thisMonday = mondayOf(today);

      // Two prior days in the baseline window, then today: still short.
      for (let back = 1; back <= 2; back += 1) {
        await prisma.performanceEvent.create({
          data: {
            userId: userA,
            localDate: toDateColumn(shift(thisMonday, -back)),
            complexity: 1,
            speedFactor: 1,
            score: 100,
          },
        });
      }

      const id = await seedTask(userA);
      await patchTask(userA, id, { status: 'done' }).expect(200);

      const body = json<ActivityMetrics>(await activity(userA).expect(200));

      expect(body.week).toEqual({ status: 'no-data' });
    });

    it('never leaks another user’s events', async () => {
      const id = await seedTask(userB);
      await patchTask(userB, id, { status: 'done' }).expect(200);

      const body = json<ActivityMetrics>(await activity(userA).expect(200));

      expect(body.counts.completedToday).toBe(0);
      expect(body.pending).toBe(0);
      expect(body.series.every((point) => point.rating === null)).toBe(true);
    });

    it('refuses a request with no session', async () => {
      // The stubbed guard answers 403; the real guard's 401 is covered by
      // auth.e2e-spec.ts. What matters here is that the route is guarded.
      await request(http()).get('/me/activity').expect(403);
    });
  });
});

function shift(calendarDate: string, days: number): string {
  return new Date(toDateColumn(calendarDate).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

interface ExecutionContextLike {
  switchToHttp: () => { getRequest: () => AuthenticatedRequest };
}
