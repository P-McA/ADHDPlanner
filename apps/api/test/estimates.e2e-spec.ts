import { XP_ESTIMATE_REVIEW, type Task, type TaskPage } from '@adhd/shared';
import { type ExecutionContext, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ESTIMATOR } from '../src/ai/ai.ports.js';
import { ProviderError } from '../src/ai/provider-error.js';
import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FAKE_ESTIMATE, FakeEstimator } from './fakes/ai.fakes.js';

/**
 * "How long will this take?", end to end: real routes, real Postgres, the
 * model replaced at its port by {@link FakeEstimator}.
 *
 * The fence is the point, as with steps. The model's answer is a *suggestion*
 * (`suggestedEstimateMinutes`) and only the user moves it into their own
 * estimate (`estimateMinutes`) — by accepting it, correcting it, or setting
 * one directly. Reviewing pays 1 XP, at most once per task.
 */
describe('Estimating a task (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userA: string;
  let userB: string;
  const estimator = new FakeEstimator();

  const suffix = Date.now().toString(36);
  const http = (): Server => app.getHttpServer() as Server;
  const json = <T>(res: Response): T => res.body as T;
  const asUser = (userId: string): Record<string, string> => ({ 'x-test-user': userId });

  async function task(userId: string, body: Record<string, unknown>): Promise<Task> {
    const res = await request(http()).post('/tasks').set(asUser(userId)).send(body).expect(201);

    return json<Task>(res);
  }

  const estimate = (userId: string, id: string) =>
    request(http()).post(`/tasks/${id}/estimate`).set(asUser(userId));

  const accept = (userId: string, id: string, body: Record<string, unknown> = {}) =>
    request(http()).post(`/tasks/${id}/estimate/accept`).set(asUser(userId)).send(body);

  const dismiss = (userId: string, id: string) =>
    request(http()).post(`/tasks/${id}/estimate/dismiss`).set(asUser(userId));

  /** XP the ledger holds for estimate reviews — what the routes paid, and nothing else. */
  const reviewXp = async (userId: string): Promise<number> => {
    const rows = await prisma.xpEvent.findMany({ where: { userId, type: 'estimate_reviewed' } });

    return rows.reduce((sum, row) => sum + row.xpAmount, 0);
  };

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
      .overrideProvider(ESTIMATOR)
      .useValue(estimator)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');

    prisma = app.get(PrismaService);

    const [a, b] = await Promise.all([
      prisma.user.create({
        data: { clerkId: `clerk_est_a_${suffix}`, email: `est_a_${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { clerkId: `clerk_est_b_${suffix}`, email: `est_b_${suffix}@test.local` },
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
    await prisma.xpEvent.deleteMany({ where: { userId: { in: [userA, userB] } } });
    estimator.result = () => Promise.resolve(FAKE_ESTIMATE);
    estimator.calls.length = 0;
  });

  describe('POST /tasks/:id/estimate', () => {
    it('stores the model’s answer as a suggestion, and leaves the user’s estimate alone', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });

      const res = await estimate(userA, parent.id).expect(200);

      expect(json<Task>(res)).toMatchObject({
        id: parent.id,
        suggestedEstimateMinutes: FAKE_ESTIMATE,
        estimateMinutes: null,
      });
      // Asking pays nothing — only reviewing does.
      expect(await reviewXp(userA)).toBe(0);
    });

    it('tells the model the task and its notes, and nothing else', async () => {
      const parent = await task(userA, { title: 'File the tax return', description: 'Self-assessment' });

      await estimate(userA, parent.id).expect(200);

      expect(estimator.calls).toEqual([{ title: 'File the tax return', description: 'Self-assessment' }]);
    });

    it('404s on someone else’s task, and asks the model nothing', async () => {
      const theirs = await task(userB, { title: 'Theirs' });

      await estimate(userA, theirs.id).expect(404);

      expect(estimator.calls).toHaveLength(0);
    });

    it('409s while a suggestion is waiting, without paying the model again', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });
      await estimate(userA, parent.id).expect(200);

      await estimate(userA, parent.id).expect(409);

      expect(estimator.calls).toHaveLength(1);
    });

    it('asks again once the earlier suggestion has been reviewed', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });
      await estimate(userA, parent.id).expect(200);
      await accept(userA, parent.id).expect(200);

      await estimate(userA, parent.id).expect(200);

      expect(estimator.calls).toHaveLength(2);
    });

    it('409s on a finished or binned task', async () => {
      const done = await task(userA, { title: 'Done already' });
      const binned = await task(userA, { title: 'Binned' });
      for (const [id, status] of [
        [done.id, 'done'],
        [binned.id, 'archived'],
      ] as const) {
        await request(http()).patch(`/tasks/${id}`).set(asUser(userA)).send({ status }).expect(200);
      }

      await estimate(userA, done.id).expect(409);
      await estimate(userA, binned.id).expect(409);

      expect(estimator.calls).toHaveLength(0);
    });

    it('409s on a suggestion nobody has confirmed — approve it first', async () => {
      const draft = await prisma.task.create({
        data: { userId: userA, title: 'Suggested', source: 'ai_suggested', confirmedAt: null },
      });

      await estimate(userA, draft.id).expect(409);

      expect(estimator.calls).toHaveLength(0);
    });

    it('answers 502 with the reason when the model fails, and writes nothing', async () => {
      estimator.result = () => Promise.reject(new ProviderError('Estimation returned 500: boom', 'retryable'));
      const parent = await task(userA, { title: 'Book the MOT' });

      const res = await estimate(userA, parent.id).expect(502);

      expect(json<{ message: string }>(res).message).toContain('Estimation returned 500: boom');
      const row = await prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
      expect(row.suggestedEstimateMinutes).toBeNull();
    });
  });

  describe('POST /tasks/:id/estimate/accept', () => {
    it('makes the suggestion the user’s estimate, and pays the review XP', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });
      await estimate(userA, parent.id).expect(200);

      const res = await accept(userA, parent.id).expect(200);

      expect(json<Task>(res)).toMatchObject({
        estimateMinutes: FAKE_ESTIMATE,
        suggestedEstimateMinutes: null,
      });
      expect(await reviewXp(userA)).toBe(XP_ESTIMATE_REVIEW);
    });

    it('takes a corrected bucket instead, and pays exactly the same', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });
      await estimate(userA, parent.id).expect(200);

      const res = await accept(userA, parent.id, { minutes: 120 }).expect(200);

      expect(json<Task>(res)).toMatchObject({ estimateMinutes: 120, suggestedEstimateMinutes: null });
      expect(await reviewXp(userA)).toBe(XP_ESTIMATE_REVIEW);
    });

    it('refuses a correction that is not one of the buckets', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });
      await estimate(userA, parent.id).expect(200);

      await accept(userA, parent.id, { minutes: 37 }).expect(400);

      const row = await prisma.task.findUniqueOrThrow({ where: { id: parent.id } });
      expect(row.suggestedEstimateMinutes).toBe(FAKE_ESTIMATE);
      expect(await reviewXp(userA)).toBe(0);
    });

    it('409s when there is no suggestion to accept, and pays nothing', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });

      await accept(userA, parent.id).expect(409);

      expect(await reviewXp(userA)).toBe(0);
    });

    it('pays once per task, however many times it is estimated and accepted', async () => {
      // Estimate → accept → estimate → accept must not be an XP tap.
      const parent = await task(userA, { title: 'Book the MOT' });

      for (let round = 0; round < 3; round++) {
        await estimate(userA, parent.id).expect(200);
        await accept(userA, parent.id).expect(200);
      }

      expect(await reviewXp(userA)).toBe(XP_ESTIMATE_REVIEW);
    });

    it('accepts once when two presses land together', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });
      await estimate(userA, parent.id).expect(200);

      const results = await Promise.all([accept(userA, parent.id), accept(userA, parent.id)]);

      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(await reviewXp(userA)).toBe(XP_ESTIMATE_REVIEW);
    });

    it('404s on someone else’s task, and pays nobody', async () => {
      const theirs = await task(userB, { title: 'Theirs' });
      await estimate(userB, theirs.id).expect(200);

      await accept(userA, theirs.id).expect(404);

      const row = await prisma.task.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(row.suggestedEstimateMinutes).toBe(FAKE_ESTIMATE);
      expect(await reviewXp(userA)).toBe(0);
      expect(await reviewXp(userB)).toBe(0);
    });
  });

  describe('POST /tasks/:id/estimate/dismiss', () => {
    it('drops the suggestion, keeps the user’s own estimate, and pays the same review XP', async () => {
      const parent = await task(userA, { title: 'Book the MOT', estimateMinutes: 15 });
      await estimate(userA, parent.id).expect(200);

      const res = await dismiss(userA, parent.id).expect(200);

      expect(json<Task>(res)).toMatchObject({ estimateMinutes: 15, suggestedEstimateMinutes: null });
      expect(await reviewXp(userA)).toBe(XP_ESTIMATE_REVIEW);
    });

    it('409s when there is nothing to dismiss', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });

      await dismiss(userA, parent.id).expect(409);

      expect(await reviewXp(userA)).toBe(0);
    });
  });

  describe('the user’s own estimate', () => {
    it('can be set directly, with no model and no XP', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });

      const res = await request(http())
        .patch(`/tasks/${parent.id}`)
        .set(asUser(userA))
        .send({ estimateMinutes: 60 })
        .expect(200);

      expect(json<Task>(res).estimateMinutes).toBe(60);
      expect(estimator.calls).toHaveLength(0);
      expect(await reviewXp(userA)).toBe(0);
    });

    it('can be cleared, and refuses anything that is not a bucket', async () => {
      const parent = await task(userA, { title: 'Book the MOT', estimateMinutes: 60 });
      const patch = (body: Record<string, unknown>) =>
        request(http()).patch(`/tasks/${parent.id}`).set(asUser(userA)).send(body);

      await patch({ estimateMinutes: 37 }).expect(400);
      const res = await patch({ estimateMinutes: null }).expect(200);

      expect(json<Task>(res).estimateMinutes).toBeNull();
    });

    it('cannot write the suggestion through an edit — only the model writes that', async () => {
      const parent = await task(userA, { title: 'Book the MOT' });

      await request(http())
        .patch(`/tasks/${parent.id}`)
        .set(asUser(userA))
        .send({ suggestedEstimateMinutes: 30 })
        .expect(400);
      await request(http())
        .post('/tasks')
        .set(asUser(userA))
        .send({ title: 'Sneaky', suggestedEstimateMinutes: 30 })
        .expect(400);
    });

    it('comes back on the task list with the suggestion beside it', async () => {
      const parent = await task(userA, { title: 'Book the MOT', estimateMinutes: 15 });
      await estimate(userA, parent.id).expect(200);

      const res = await request(http()).get('/tasks').set(asUser(userA)).expect(200);

      expect(json<TaskPage>(res).items[0]).toMatchObject({
        estimateMinutes: 15,
        suggestedEstimateMinutes: FAKE_ESTIMATE,
      });
    });
  });
});
