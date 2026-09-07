import type { DeleteTaskResult, Task, TaskPage } from '@adhd/shared';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * End-to-end tests against the docker-compose Postgres.
 *
 * Clerk is stubbed at the guard rather than over the network: issuing real
 * session tokens needs live Clerk credentials, and what is under test here is
 * ownership scoping, which begins *after* authentication has resolved a user.
 * The `x-test-user` header stands in for that resolved subject.
 *
 * Everything below the guard — routing, the global ValidationPipe, the service,
 * Prisma, and the ON DELETE CASCADE in Postgres — is the real thing.
 */
describe('Tasks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userA: string;
  let userB: string;

  // Keeps the seeded users unique if a previous run died before its cleanup.
  const suffix = Date.now().toString(36);

  /** Nest types getHttpServer() as `any`; narrow once, here. */
  const http = (): Server => app.getHttpServer() as Server;

  /** Supertest types `body` as `any`; assert it against the shared contract. */
  const json = <T>(res: Response): T => res.body as T;

  const asUser = (userId: string): Record<string, string> => ({ 'x-test-user': userId });

  const createTask = (userId: string, body: Record<string, unknown>): Promise<Response> =>
    request(http()).post('/tasks').set(asUser(userId)).send(body);

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
    // Mirrors main.ts. Without it the validation cases below would pass here
    // and still fail in production for want of a pipe.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = app.get(PrismaService);

    const [a, b] = await Promise.all([
      prisma.user.create({
        data: { clerkId: `clerk_a_${suffix}`, email: `a_${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { clerkId: `clerk_b_${suffix}`, email: `b_${suffix}@test.local` },
      }),
    ]);
    userA = a.id;
    userB = b.id;
  });

  afterAll(async () => {
    // Their tasks go with them via ON DELETE CASCADE.
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await app.close();
  });

  beforeEach(async () => {
    await prisma.task.deleteMany({ where: { userId: { in: [userA, userB] } } });
  });

  describe('cross-user isolation', () => {
    it("A cannot read B's task", async () => {
      const created = json<Task>(await createTask(userB, { title: "B's task" }));

      const res = await request(http()).get(`/tasks/${created.id}`).set(asUser(userA));

      expect(res.status).toBe(404);
    });

    it("A cannot update B's task", async () => {
      const created = json<Task>(await createTask(userB, { title: "B's task" }));

      const res = await request(http())
        .patch(`/tasks/${created.id}`)
        .set(asUser(userA))
        .send({ title: 'hijacked' });

      expect(res.status).toBe(404);

      // The row must be untouched, not merely the response rejected.
      const after = await prisma.task.findUnique({ where: { id: created.id } });
      expect(after?.title).toBe("B's task");
    });

    it("A cannot delete B's task", async () => {
      const created = json<Task>(await createTask(userB, { title: "B's task" }));

      const res = await request(http()).delete(`/tasks/${created.id}`).set(asUser(userA));

      expect(res.status).toBe(404);
      expect(await prisma.task.findUnique({ where: { id: created.id } })).not.toBeNull();
    });

    it("B's tasks never appear in A's list", async () => {
      await createTask(userB, { title: "B's task" });
      await createTask(userA, { title: "A's task" });

      const res = await request(http()).get('/tasks').set(asUser(userA));
      const page = json<TaskPage>(res);

      expect(res.status).toBe(200);
      expect(page.total).toBe(1);
      expect(page.items[0]?.title).toBe("A's task");
    });
  });

  describe('cascade delete', () => {
    it('returns the correct subtask count and actually removes them', async () => {
      const parent = json<Task>(await createTask(userA, { title: 'parent' }));
      await createTask(userA, { title: 'sub 1', parentTaskId: parent.id });
      await createTask(userA, { title: 'sub 2', parentTaskId: parent.id });

      const res = await request(http()).delete(`/tasks/${parent.id}`).set(asUser(userA));

      expect(res.status).toBe(200);
      expect(json<DeleteTaskResult>(res)).toEqual({ id: parent.id, deletedSubtasks: 2 });
      expect(await prisma.task.count({ where: { userId: userA } })).toBe(0);
    });

    it('reports zero for a task with no subtasks', async () => {
      const solo = json<Task>(await createTask(userA, { title: 'solo' }));

      const res = await request(http()).delete(`/tasks/${solo.id}`).set(asUser(userA));

      expect(json<DeleteTaskResult>(res).deletedSubtasks).toBe(0);
    });
  });

  describe('validation', () => {
    it('rejects an invalid status enum with 400', async () => {
      const created = json<Task>(await createTask(userA, { title: 'x' }));

      const res = await request(http())
        .patch(`/tasks/${created.id}`)
        .set(asUser(userA))
        .send({ status: 'not_a_status' });

      expect(res.status).toBe(400);
    });

    it('rejects an invalid manualPriority enum with 400', async () => {
      const res = await createTask(userA, { title: 'x', manualPriority: 'urgent-ish' });

      expect(res.status).toBe(400);
    });

    it('rejects a malformed UUID path param with 400', async () => {
      const res = await request(http()).get('/tasks/not-a-uuid').set(asUser(userA));

      expect(res.status).toBe(400);
    });

    it('rejects a malformed UUID as parentTaskId with 400', async () => {
      const res = await createTask(userA, { title: 'x', parentTaskId: 'nope' });

      expect(res.status).toBe(400);
    });

    it('rejects a missing title with 400', async () => {
      const res = await createTask(userA, {});

      expect(res.status).toBe(400);
    });

    it('rejects a title longer than 500 characters', async () => {
      const res = await createTask(userA, { title: 'x'.repeat(501) });

      expect(res.status).toBe(400);
    });

    it('accepts a title of exactly 500 characters', async () => {
      const res = await createTask(userA, { title: 'x'.repeat(500) });

      expect(res.status).toBe(201);
    });

    it('rejects a non-ISO dueAt with 400', async () => {
      const res = await createTask(userA, { title: 'x', dueAt: 'next tuesday' });

      expect(res.status).toBe(400);
    });

    it('rejects source on update — provenance is immutable', async () => {
      const created = json<Task>(await createTask(userA, { title: 'x' }));

      const res = await request(http())
        .patch(`/tasks/${created.id}`)
        .set(asUser(userA))
        .send({ source: 'voice' });

      expect(res.status).toBe(400);
    });

    it('rejects parentTaskId on update — re-parenting is deferred', async () => {
      const created = json<Task>(await createTask(userA, { title: 'x' }));
      const other = json<Task>(await createTask(userA, { title: 'other' }));

      const res = await request(http())
        .patch(`/tasks/${created.id}`)
        .set(asUser(userA))
        .send({ parentTaskId: other.id });

      expect(res.status).toBe(400);
    });

    it('rejects an attempt to set userId directly', async () => {
      const res = await createTask(userA, { title: 'x', userId: userB });

      expect(res.status).toBe(400);
    });
  });

  describe('parentTaskId ownership', () => {
    it('rejects a parent belonging to another user with 400', async () => {
      const bTask = json<Task>(await createTask(userB, { title: "B's task" }));

      const res = await createTask(userA, { title: 'child', parentTaskId: bTask.id });

      expect(res.status).toBe(400);
      expect(await prisma.task.count({ where: { userId: userA } })).toBe(0);
    });

    it('accepts a parent the caller owns', async () => {
      const parent = json<Task>(await createTask(userA, { title: 'parent' }));

      const res = await createTask(userA, { title: 'child', parentTaskId: parent.id });

      expect(res.status).toBe(201);
      expect(json<Task>(res).parentTaskId).toBe(parent.id);
    });
  });

  describe('pagination and ordering', () => {
    it('defaults to a limit of 25 at offset 0', async () => {
      const page = json<TaskPage>(await request(http()).get('/tasks').set(asUser(userA)));

      expect(page.limit).toBe(25);
      expect(page.offset).toBe(0);
    });

    it('rejects a limit above the 100 cap with 400 rather than clamping', async () => {
      const res = await request(http()).get('/tasks?limit=101').set(asUser(userA));

      expect(res.status).toBe(400);
    });

    it('accepts a limit of exactly 100', async () => {
      const res = await request(http()).get('/tasks?limit=100').set(asUser(userA));

      expect(res.status).toBe(200);
      expect(json<TaskPage>(res).limit).toBe(100);
    });

    it('rejects a zero or negative limit', async () => {
      const zero = await request(http()).get('/tasks?limit=0').set(asUser(userA));
      const negative = await request(http()).get('/tasks?limit=-1').set(asUser(userA));

      expect(zero.status).toBe(400);
      expect(negative.status).toBe(400);
    });

    it('returns an empty page for an offset beyond the end', async () => {
      await createTask(userA, { title: 'only' });

      const res = await request(http()).get('/tasks?offset=50').set(asUser(userA));
      const page = json<TaskPage>(res);

      expect(res.status).toBe(200);
      expect(page.items).toEqual([]);
      // total still counts the whole filter, so a client can correct itself.
      expect(page.total).toBe(1);
    });

    it('pages without overlap or gaps', async () => {
      for (const title of ['a', 'b', 'c']) {
        await createTask(userA, { title });
      }

      const first = json<TaskPage>(
        await request(http()).get('/tasks?limit=2&offset=0').set(asUser(userA)),
      );
      const second = json<TaskPage>(
        await request(http()).get('/tasks?limit=2&offset=2').set(asUser(userA)),
      );

      expect(first.items).toHaveLength(2);
      expect(second.items).toHaveLength(1);
      expect(new Set([...first.items, ...second.items].map((t) => t.id)).size).toBe(3);
    });

    it('filters by status', async () => {
      const done = json<Task>(await createTask(userA, { title: 'finished' }));
      await createTask(userA, { title: 'outstanding' });
      await request(http())
        .patch(`/tasks/${done.id}`)
        .set(asUser(userA))
        .send({ status: 'done' });

      const page = json<TaskPage>(
        await request(http()).get('/tasks?status=done').set(asUser(userA)),
      );

      expect(page.total).toBe(1);
      expect(page.items[0]?.title).toBe('finished');
    });

    it('orders by dueAt ascending with nulls last, then createdAt descending', async () => {
      // Created in sequence so the createdAt tiebreak is deterministic.
      await createTask(userA, { title: 'undated, created first' });
      await createTask(userA, { title: 'undated, created second' });
      await createTask(userA, { title: 'due later', dueAt: '2026-12-01T00:00:00.000Z' });
      await createTask(userA, { title: 'due sooner', dueAt: '2026-01-01T00:00:00.000Z' });

      const page = json<TaskPage>(await request(http()).get('/tasks').set(asUser(userA)));

      expect(page.items.map((t) => t.title)).toEqual([
        'due sooner',
        'due later',
        // Both undated, so the newest-created wins.
        'undated, created second',
        'undated, created first',
      ]);
    });
  });
});

/**
 * The slice of ExecutionContext the stub guard touches. Narrower than Nest's
 * own type so the stub does not have to implement the whole interface.
 */
interface ExecutionContextLike {
  switchToHttp: () => { getRequest: () => AuthenticatedRequest };
}
