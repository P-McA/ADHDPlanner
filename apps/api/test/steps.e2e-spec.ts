import {
  isTaskDraft,
  XP_DRAFT_REVIEW,
  XP_STEP_COMPLETE,
  xpForCompletion,
  type Task,
  type TaskPage,
} from '@adhd/shared';
import { type ExecutionContext, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DECOMPOSER } from '../src/ai/ai.ports.js';
import { ProviderError } from '../src/ai/provider-error.js';
import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FAKE_STEPS, FakeDecomposer } from './fakes/ai.fakes.js';

/**
 * "Break this into steps", end to end: real routes, real Postgres, the model
 * replaced at its port by {@link FakeDecomposer}.
 *
 * The fence is the point. Steps are AI-authored task rows, so every rule the
 * flat suggestions needed — drafts until confirmed, no completing a draft, kept
 * out of the default list — has to hold on a tree too, and is asserted here
 * against the endpoints rather than a component.
 */
describe('Breaking a task into steps (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userA: string;
  let userB: string;
  const decomposer = new FakeDecomposer();

  const suffix = Date.now().toString(36);
  const http = (): Server => app.getHttpServer() as Server;
  const json = <T>(res: Response): T => res.body as T;
  const asUser = (userId: string): Record<string, string> => ({ 'x-test-user': userId });

  async function task(userId: string, body: Record<string, unknown>): Promise<Task> {
    const res = await request(http()).post('/tasks').set(asUser(userId)).send(body).expect(201);

    return json<Task>(res);
  }

  const breakDown = (userId: string, id: string) =>
    request(http()).post(`/tasks/${id}/steps`).set(asUser(userId));

  const stepsOf = (userId: string, id: string) =>
    request(http()).get(`/tasks/${id}/steps`).set(asUser(userId));

  const approve = (userId: string, id: string) =>
    request(http()).post(`/tasks/${id}/approve`).set(asUser(userId)).expect(200);

  const complete = (userId: string, id: string) =>
    request(http()).patch(`/tasks/${id}`).set(asUser(userId)).send({ status: 'done' });

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
      .overrideProvider(DECOMPOSER)
      .useValue(decomposer)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');

    prisma = app.get(PrismaService);

    const [a, b] = await Promise.all([
      prisma.user.create({
        data: { clerkId: `clerk_steps_a_${suffix}`, email: `steps_a_${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { clerkId: `clerk_steps_b_${suffix}`, email: `steps_b_${suffix}@test.local` },
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
    decomposer.result = () => Promise.resolve([...FAKE_STEPS]);
    decomposer.calls.length = 0;
  });

  describe('POST /tasks/:id/steps', () => {
    it('suggests the steps under the task, in order, as drafts nobody has confirmed', async () => {
      const parent = await task(userA, { title: 'Book the car in for its MOT' });

      const res = await breakDown(userA, parent.id).expect(201);
      const steps = json<Task[]>(res);

      expect(steps.map((s) => s.title)).toEqual(FAKE_STEPS.map((s) => s.title));
      expect(steps.map((s) => s.stepOrder)).toEqual([0, 1, 2]);
      for (const step of steps) {
        expect(step.parentTaskId).toBe(parent.id);
        expect(isTaskDraft(step)).toBe(true);
      }
      expect(await prisma.task.count({ where: { parentTaskId: parent.id } })).toBe(3);
    });

    it('tells the model the task and its notes, and nothing else', async () => {
      const parent = await task(userA, { title: 'Sort the garage', description: 'Before the skip comes' });

      await breakDown(userA, parent.id).expect(201);

      expect(decomposer.calls).toEqual([{ title: 'Sort the garage', description: 'Before the skip comes' }]);
    });

    it('404s on someone else’s task, and asks the model nothing', async () => {
      const parent = await task(userB, { title: 'Theirs' });

      await breakDown(userA, parent.id).expect(404);

      expect(decomposer.calls).toHaveLength(0);
      expect(await prisma.task.count({ where: { parentTaskId: parent.id } })).toBe(0);
    });

    it('409s on a step — steps are one level deep', async () => {
      const parent = await task(userA, { title: 'Parent' });
      const child = await task(userA, { title: 'A step', parentTaskId: parent.id });

      await breakDown(userA, child.id).expect(409);

      expect(decomposer.calls).toHaveLength(0);
    });

    it('409s while earlier suggestions are unreviewed, without paying the model again', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      await breakDown(userA, parent.id).expect(201);

      await breakDown(userA, parent.id).expect(409);

      expect(decomposer.calls).toHaveLength(1);
      expect(await prisma.task.count({ where: { parentTaskId: parent.id } })).toBe(3);
    });

    it('suggests again once the earlier suggestions have all been reviewed', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      const first = json<Task[]>(await breakDown(userA, parent.id).expect(201));
      for (const step of first) {
        await request(http()).post(`/tasks/${step.id}/reject`).set(asUser(userA)).expect(200);
      }

      await breakDown(userA, parent.id).expect(201);

      expect(decomposer.calls).toHaveLength(2);
    });

    it('starts one set of steps when two presses land together', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      // Slow enough that both presses are past every check before either writes.
      decomposer.result = () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve([...FAKE_STEPS]);
          }, 100);
        });

      const [a, b] = await Promise.all([breakDown(userA, parent.id), breakDown(userA, parent.id)]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await prisma.task.count({ where: { parentTaskId: parent.id } })).toBe(3);
    });

    it('409s on a finished or binned task', async () => {
      const done = await task(userA, { title: 'Done already' });
      await complete(userA, done.id).expect(200);
      const binned = await task(userA, { title: 'Binned' });
      await request(http()).patch(`/tasks/${binned.id}`).set(asUser(userA)).send({ status: 'archived' }).expect(200);

      await breakDown(userA, done.id).expect(409);
      await breakDown(userA, binned.id).expect(409);
      expect(decomposer.calls).toHaveLength(0);
    });

    it('409s on a suggestion nobody has confirmed — approve it first', async () => {
      const draft = await prisma.task.create({
        data: { userId: userA, title: 'An AI suggestion', source: 'ai_suggested', confirmedAt: null },
      });

      await breakDown(userA, draft.id).expect(409);

      expect(decomposer.calls).toHaveLength(0);
    });

    it('answers 502 with the reason when the model fails, and leaves nothing behind', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      decomposer.result = () =>
        Promise.reject(ProviderError.fromStatus('Decomposition returned 429: slow down', 429));

      const res = await breakDown(userA, parent.id).expect(502);

      expect(json<{ message: string }>(res).message).toContain('Decomposition returned 429');
      expect(await prisma.task.count({ where: { parentTaskId: parent.id } })).toBe(0);
    });

    it('answers with no steps when the task is already one small action', async () => {
      const parent = await task(userA, { title: 'Text Sam' });
      decomposer.result = () => Promise.resolve([]);

      const res = await breakDown(userA, parent.id).expect(201);

      expect(json<Task[]>(res)).toEqual([]);
    });
  });

  describe('reviewing and finishing steps', () => {
    it('adds a step through the ordinary approve route, paying the review XP', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      const [step] = json<Task[]>(await breakDown(userA, parent.id).expect(201));

      const approved = json<Task>(await approve(userA, step!.id));

      expect(approved.confirmedAt).not.toBeNull();
      const ledger = await prisma.xpEvent.findMany({ where: { userId: userA } });
      expect(ledger.map((e) => [e.type, e.xpAmount])).toEqual([['draft_reviewed', XP_DRAFT_REVIEW]]);
    });

    it('refuses to complete a step nobody has confirmed', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      const [step] = json<Task[]>(await breakDown(userA, parent.id).expect(201));

      await complete(userA, step!.id).expect(409);
    });

    it('pays a finished step the step amount, and the parent still pays in full', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      const [step] = json<Task[]>(await breakDown(userA, parent.id).expect(201));
      await approve(userA, step!.id);
      await prisma.xpEvent.deleteMany({ where: { userId: userA } });

      await complete(userA, step!.id).expect(200);
      await complete(userA, parent.id).expect(200);

      const paid = await prisma.xpEvent.findMany({
        where: { userId: userA, type: 'task_complete' },
        orderBy: { createdAt: 'asc' },
      });
      expect(paid.map((e) => [e.taskId, e.xpAmount])).toEqual([
        [step!.id, XP_STEP_COMPLETE],
        [parent.id, xpForCompletion(parent.manualPriority)],
      ]);
    });

    it('lets the parent be finished with steps still open', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      await breakDown(userA, parent.id).expect(201);

      await complete(userA, parent.id).expect(200);
    });

    it('takes the draft steps with it when the parent is deleted', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      await breakDown(userA, parent.id).expect(201);

      await request(http()).delete(`/tasks/${parent.id}`).set(asUser(userA)).expect(200);

      expect(await prisma.task.count({ where: { parentTaskId: parent.id } })).toBe(0);
    });
  });

  describe('GET /tasks/:id/steps', () => {
    it('lists the steps in order, suggestions included, rejected ones left out', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      const steps = json<Task[]>(await breakDown(userA, parent.id).expect(201));
      await approve(userA, steps[0]!.id);
      await request(http()).post(`/tasks/${steps[1]!.id}/reject`).set(asUser(userA)).expect(200);

      const listed = json<Task[]>(await stepsOf(userA, parent.id).expect(200));

      expect(listed.map((s) => s.id)).toEqual([steps[0]!.id, steps[2]!.id]);
      expect(isTaskDraft(listed[0]!)).toBe(false);
      expect(isTaskDraft(listed[1]!)).toBe(true);
    });

    it('404s on someone else’s task', async () => {
      const parent = await task(userB, { title: 'Theirs' });

      await stepsOf(userA, parent.id).expect(404);
    });
  });

  describe('GET /tasks keeps steps under their parent', () => {
    it('lists the parent and not its steps, even approved ones', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      const [step] = json<Task[]>(await breakDown(userA, parent.id).expect(201));
      await approve(userA, step!.id);

      const page = json<TaskPage>(await request(http()).get('/tasks').set(asUser(userA)).expect(200));

      expect(page.items.map((t) => t.id)).toEqual([parent.id]);
      expect(page.total).toBe(1);
    });

    it('keeps step suggestions out of the suggestions list too', async () => {
      const parent = await task(userA, { title: 'Book the car in' });
      await breakDown(userA, parent.id).expect(201);

      const page = json<TaskPage>(
        await request(http()).get('/tasks?include=drafts').set(asUser(userA)).expect(200),
      );

      expect(page.items.map((t) => t.id)).toEqual([parent.id]);
    });
  });
});
