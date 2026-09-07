import type { Task, UserStats } from '@adhd/shared';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { GamificationService } from '../src/gamification/gamification.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * XP ledger, streaks and GET /me/stats against the docker-compose Postgres.
 *
 * The guard is stubbed exactly as in tasks.e2e-spec.ts; everything below it —
 * the transaction, the BIGSERIAL ledger, the DATE column, ON DELETE CASCADE —
 * is real, which is what makes the atomicity case below meaningful.
 */
describe('Gamification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userA: string;
  let userB: string;

  const suffix = Date.now().toString(36);

  const http = (): Server => app.getHttpServer() as Server;
  const json = <T>(res: Response): T => res.body as T;
  const asUser = (userId: string): Record<string, string> => ({ 'x-test-user': userId });

  const createTask = (userId: string, body: Record<string, unknown> = {}): Promise<Response> =>
    request(http())
      .post('/tasks')
      .set(asUser(userId))
      .send({ title: 'seed', ...body });

  const patch = (userId: string, id: string, body: Record<string, unknown>): Promise<Response> =>
    request(http()).patch(`/tasks/${id}`).set(asUser(userId)).send(body);

  /** Creates a task and returns its id. */
  const seedTask = async (userId: string, body: Record<string, unknown> = {}): Promise<string> => {
    const res = await createTask(userId, body);
    expect(res.status).toBe(201);
    return json<Task>(res).id;
  };

  /** Every ledger row for a task, oldest first. */
  const ledgerFor = (taskId: string) =>
    prisma.xpEvent.findMany({ where: { taskId }, orderBy: { id: 'asc' } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ClerkAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContextLike): boolean => {
          const req = context.switchToHttp().getRequest();
          const id = req.headers['x-test-user'];

          if (typeof id !== 'string') {
            return false;
          }

          req.appUser = { id, clerkId: `clerk_${id}` };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);

    const [a, b] = await Promise.all([
      prisma.user.create({
        data: { clerkId: `clerk_g_a_${suffix}`, email: `g_a_${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { clerkId: `clerk_g_b_${suffix}`, email: `g_b_${suffix}@test.local` },
      }),
    ]);
    userA = a.id;
    userB = b.id;
  });

  beforeEach(async () => {
    // Ledger and streak rows cascade from the tasks/users, but the streak row
    // hangs off the user and would otherwise leak between cases.
    await prisma.task.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.xpEvent.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.streak.deleteMany({ where: { userId: { in: [userA, userB] } } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await app.close();
  });

  describe('awarding', () => {
    it('writes exactly one ledger row when a task is completed twice', async () => {
      const id = await seedTask(userA);

      expect((await patch(userA, id, { status: 'done' })).status).toBe(200);
      expect((await patch(userA, id, { status: 'done' })).status).toBe(200);

      // XP is paid for the transition into done, not for being done. Without
      // the guard in TasksService.update, the second PATCH pays again.
      const rows = await ledgerFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.xpAmount).toBe(10);
    });

    it('pays exactly once when the same task is completed twice concurrently', async () => {
      const id = await seedTask(userA, { manualPriority: 'urgent' });

      // Both requests are in flight before either transaction commits, which
      // is the case a read-then-write guard cannot survive: both would observe
      // a non-done status. The guard is a conditional UPDATE instead, so
      // Postgres serialises them on the row and the loser matches nothing.
      const [first, second] = await Promise.all([
        patch(userA, id, { status: 'done' }),
        patch(userA, id, { status: 'done' }),
      ]);

      // Both callers asked for done and both got it, so both are 200. Which of
      // them did the completing is deliberately invisible: the loser reads back
      // the winner's committed row, so the two responses are identical.
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(json<Task>(first).status).toBe('done');
      expect(json<Task>(second).status).toBe('done');
      expect(json<Task>(first).completedAt).toBe(json<Task>(second).completedAt);

      const rows = await ledgerFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.xpAmount).toBe(15);

      // And the streak counted the day once, not twice.
      const stats = json<UserStats>(await request(http()).get('/me/stats').set(asUser(userA)));
      expect(stats.totalXp).toBe(15);
      expect(stats.currentStreak).toBe(1);
    });

    it('applies other edits even when the completion itself is a no-op', async () => {
      const id = await seedTask(userA);
      await patch(userA, id, { status: 'done' });

      // The task is already done, so the transition matches nothing — but the
      // rename was still asked for and must not be dropped with it.
      const res = await patch(userA, id, { status: 'done', title: 'renamed anyway' });

      expect(res.status).toBe(200);
      expect(json<Task>(res).title).toBe('renamed anyway');
      expect(await ledgerFor(id)).toHaveLength(1);
    });

    it('awards again when a task is reopened and completed a second time', async () => {
      const id = await seedTask(userA);

      await patch(userA, id, { status: 'done' });
      await patch(userA, id, { status: 'pending' });
      await patch(userA, id, { status: 'done' });

      // A genuine second transition, so a genuine second award.
      expect(await ledgerFor(id)).toHaveLength(2);
    });

    it('awards nothing for an update that does not complete anything', async () => {
      const id = await seedTask(userA);

      await patch(userA, id, { title: 'renamed', manualPriority: 'urgent' });

      expect(await ledgerFor(id)).toHaveLength(0);
    });

    it.each([
      ['low', 10],
      ['med', 10],
      ['high', 13],
      ['urgent', 15],
    ] as const)('pays %s priority %i XP into the ledger', async (manualPriority, expected) => {
      const id = await seedTask(userA, { manualPriority });

      await patch(userA, id, { status: 'done' });

      const rows = await ledgerFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.xpAmount).toBe(expected);
      expect(rows[0]?.type).toBe('task_complete');
    });

    it('stamps completedAt on completion and clears it on reopening', async () => {
      const id = await seedTask(userA);

      const done = json<Task>(await patch(userA, id, { status: 'done' }));
      expect(done.completedAt).not.toBeNull();

      const reopened = json<Task>(await patch(userA, id, { status: 'pending' }));
      expect(reopened.completedAt).toBeNull();
    });
  });

  describe('transaction atomicity', () => {
    it('rolls the ledger row back when the streak write fails', async () => {
      const id = await seedTask(userA);

      // Fails between the XP insert and the streak update, which is the window
      // the single transaction exists to cover.
      const gamification = app.get(GamificationService);
      const touchStreak = vi
        .spyOn(
          gamification as unknown as { touchStreak: () => Promise<void> },
          'touchStreak',
        )
        .mockRejectedValue(new Error('streak write failed'));

      const res = await patch(userA, id, { status: 'done' });
      expect(res.status).toBe(500);
      expect(touchStreak).toHaveBeenCalledOnce();

      // Neither row persisted...
      expect(await ledgerFor(id)).toHaveLength(0);
      expect(await prisma.streak.findUnique({ where: { userId: userA } })).toBeNull();

      // ...and the task did not silently stay done with no XP behind it.
      const task = await prisma.task.findUnique({ where: { id } });
      expect(task?.status).toBe('pending');
      expect(task?.completedAt).toBeNull();
    });
  });

  describe('GET /me/stats', () => {
    it('reports zeroes for a user who has completed nothing', async () => {
      const res = await request(http()).get('/me/stats').set(asUser(userA));

      expect(res.status).toBe(200);
      expect(json<UserStats>(res)).toEqual({
        totalXp: 0,
        level: 1,
        currentStreak: 0,
        longestStreak: 0,
        lastActiveDate: null,
      });
    });

    it('aggregates the ledger and starts the streak on first completion', async () => {
      const first = await seedTask(userA, { manualPriority: 'urgent' });
      const second = await seedTask(userA, { manualPriority: 'high' });

      await patch(userA, first, { status: 'done' });
      await patch(userA, second, { status: 'done' });

      const stats = json<UserStats>(await request(http()).get('/me/stats').set(asUser(userA)));

      expect(stats.totalXp).toBe(28); // 15 + 13
      expect(stats.level).toBe(1);
      // Two completions on one day is one day of the habit.
      expect(stats.currentStreak).toBe(1);
      expect(stats.longestStreak).toBe(1);
      expect(stats.lastActiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('derives level from the ledger rather than a stored balance', async () => {
      // Ten urgent completions is 150 XP, which is level 2.
      const ids = await Promise.all(
        Array.from({ length: 10 }, () => seedTask(userA, { manualPriority: 'urgent' })),
      );
      for (const id of ids) {
        await patch(userA, id, { status: 'done' });
      }

      const stats = json<UserStats>(await request(http()).get('/me/stats').set(asUser(userA)));

      expect(stats.totalXp).toBe(150);
      expect(stats.level).toBe(2);
    });

    it('requires authentication', async () => {
      const res = await request(http()).get('/me/stats');

      expect(res.status).toBe(403);
    });
  });

  describe('cross-user isolation', () => {
    it('does not let one user see another user XP', async () => {
      const id = await seedTask(userA, { manualPriority: 'urgent' });
      await patch(userA, id, { status: 'done' });

      const statsB = json<UserStats>(await request(http()).get('/me/stats').set(asUser(userB)));

      expect(statsB.totalXp).toBe(0);
      expect(statsB.currentStreak).toBe(0);
    });

    it('does not let one user move another user XP by completing their task', async () => {
      const taskOfA = await seedTask(userA);

      // 404, not 403: ownership and existence stay indistinguishable.
      const res = await patch(userB, taskOfA, { status: 'done' });
      expect(res.status).toBe(404);

      // Nobody was paid: not B, whose request failed, and not A, whose task
      // never moved.
      expect(await ledgerFor(taskOfA)).toHaveLength(0);
      const statsA = json<UserStats>(await request(http()).get('/me/stats').set(asUser(userA)));
      expect(statsA.totalXp).toBe(0);
    });

    it('keeps each user ledger scoped to its owner', async () => {
      const taskA = await seedTask(userA, { manualPriority: 'urgent' });
      const taskB = await seedTask(userB, { manualPriority: 'low' });

      await patch(userA, taskA, { status: 'done' });
      await patch(userB, taskB, { status: 'done' });

      const statsA = json<UserStats>(await request(http()).get('/me/stats').set(asUser(userA)));
      const statsB = json<UserStats>(await request(http()).get('/me/stats').set(asUser(userB)));

      expect(statsA.totalXp).toBe(15);
      expect(statsB.totalXp).toBe(10);
    });
  });
});

interface ExecutionContextLike {
  switchToHttp: () => { getRequest: () => AuthenticatedRequest };
}
