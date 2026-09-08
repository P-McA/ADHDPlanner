import { XP_DRAFT_REVIEW } from '@adhd/shared';
import type { DeleteTaskResult, Task, TaskPage, UserStats } from '@adhd/shared';
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
    // Listen once for the whole file. Left unlistened, supertest starts and
    // closes the server around every single request; see vitest.e2e.config.ts
    // for why that surfaces as `read ECONNRESET` under a concurrent burst.
    await app.listen(0, '127.0.0.1');

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
    // Explicit now that xp_events no longer cascades with the task. That is
    // the anti-farm rule working as intended — a deleted task keeps its XP —
    // which also means test isolation has to clear the ledger itself.
    await prisma.xpEvent.deleteMany({ where: { userId: { in: [userA, userB] } } });
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

    /**
     * The anti-farm rule, and the reason `xp_events.task_id` is
     * `ON DELETE SET NULL` rather than `ON DELETE CASCADE`.
     *
     * If deleting a task refunded the XP it paid, complete-earn-delete-repeat
     * would be the cheapest XP in the app — every task farmable an unlimited
     * number of times, and the level display meaningless. The ledger's claim
     * is "this XP was legitimately earned at this time", which stays true
     * after the task is gone.
     */
    it('keeps the XP a deleted task paid, with the ledger row detached', async () => {
      const before = json<UserStats>(
        await request(http()).get('/me/stats').set(asUser(userA)).expect(200),
      );
      const task = json<Task>(await createTask(userA, { title: 'Write the report' }));

      await request(http())
        .patch(`/tasks/${task.id}`)
        .set(asUser(userA))
        .send({ status: 'done' })
        .expect(200);

      const earned = json<UserStats>(
        await request(http()).get('/me/stats').set(asUser(userA)).expect(200),
      );
      expect(earned.totalXp).toBeGreaterThan(before.totalXp);

      await request(http()).delete(`/tasks/${task.id}`).set(asUser(userA)).expect(200);

      // The row survives the task, orphaned rather than deleted.
      const ledger = await prisma.xpEvent.findMany({
        where: { userId: userA, type: 'task_complete' },
        select: { taskId: true, xpAmount: true },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.taskId).toBeNull();

      // And the number the user sees did not move.
      const after = json<UserStats>(
        await request(http()).get('/me/stats').set(asUser(userA)).expect(200),
      );
      expect(after.totalXp).toBe(earned.totalXp);
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

  describe('the draft fence on GET /tasks', () => {
    /** A task the pipeline would have produced: ai_suggested, never confirmed. */
    const createDraft = (userId: string, title: string): Promise<Response> =>
      createTask(userId, { title, source: 'ai_suggested' });

    it('leaves unconfirmed AI drafts out of the default page', async () => {
      await createTask(userA, { title: 'Typed by hand' });
      await createDraft(userA, 'Suggested by AI');

      const page = json<TaskPage>(await request(http()).get('/tasks').set(asUser(userA)).expect(200));

      // The fence is the server's job. A client that forgets `include` must not
      // be able to render a suggestion nobody approved as the user's own work.
      expect(page.items.map((t) => t.title)).toEqual(['Typed by hand']);
      // `total` is filtered too — a count that included the hidden row would
      // make the UI claim a page it cannot show.
      expect(page.total).toBe(1);
    });

    it('returns them when the caller opts in with ?include=drafts', async () => {
      await createTask(userA, { title: 'Typed by hand' });
      await createDraft(userA, 'Suggested by AI');

      const page = json<TaskPage>(
        await request(http()).get('/tasks?include=drafts').set(asUser(userA)).expect(200),
      );

      expect(page.items.map((t) => t.title).sort()).toEqual(['Suggested by AI', 'Typed by hand']);
      expect(page.total).toBe(2);
    });

    it('keeps an approved suggestion in the default page', async () => {
      const draft = json<Task>(await createDraft(userA, 'Suggested by AI'));

      await request(http()).post(`/tasks/${draft.id}/approve`).set(asUser(userA)).expect(200);

      const page = json<TaskPage>(await request(http()).get('/tasks').set(asUser(userA)).expect(200));

      // Provenance does not change on approval, so a filter keyed on `source`
      // alone would hide this forever and the user would lose the task they
      // just accepted. The filter is the pair.
      expect(page.items.map((t) => t.title)).toEqual(['Suggested by AI']);
    });

    it('still hides a draft when a status filter is also applied', async () => {
      await createDraft(userA, 'Suggested by AI');

      const page = json<TaskPage>(
        await request(http()).get('/tasks?status=pending').set(asUser(userA)).expect(200),
      );

      expect(page.items).toEqual([]);
    });

    it('rejects an include value it does not understand with 400', async () => {
      // Ignored rather than rejected, a misspelling would silently serve the
      // fenced page and the caller would conclude there was nothing to review.
      await request(http()).get('/tasks?include=draft').set(asUser(userA)).expect(400);
    });
  });

  describe('the draft fence on PATCH /tasks/:id', () => {
    const createDraft = (userId: string, title: string): Promise<Response> =>
      createTask(userId, { title, source: 'ai_suggested' });

    it('refuses to complete an unconfirmed draft, and pays no XP for it', async () => {
      const draft = json<Task>(await createDraft(userA, 'Suggested by AI'));
      const before = json<UserStats>(await request(http()).get('/me/stats').set(asUser(userA)));

      const res = await request(http())
        .patch(`/tasks/${draft.id}`)
        .set(asUser(userA))
        .send({ status: 'done' });

      // 409, not 404: the task exists and the caller owns it. What is wrong is
      // the state, and saying so is the only useful answer.
      expect(res.status).toBe(409);

      const after = json<Task>(
        await request(http()).get(`/tasks/${draft.id}`).set(asUser(userA)).expect(200),
      );

      expect(after.status).toBe('pending');
      expect(after.completedAt).toBeNull();

      // The point of the guard: no XP for work no human approved.
      const stats = json<UserStats>(await request(http()).get('/me/stats').set(asUser(userA)));
      expect(stats.totalXp).toBe(before.totalXp);
    });

    it('lets the same request through once the draft is approved', async () => {
      const draft = json<Task>(await createDraft(userA, 'Suggested by AI'));

      await request(http()).post(`/tasks/${draft.id}/approve`).set(asUser(userA)).expect(200);

      const done = json<Task>(
        await request(http())
          .patch(`/tasks/${draft.id}`)
          .set(asUser(userA))
          .send({ status: 'done' })
          .expect(200),
      );

      expect(done.status).toBe('done');
      expect(done.completedAt).not.toBeNull();
    });

    it('still allows editing a draft before it is approved', async () => {
      const draft = json<Task>(await createDraft(userA, 'Book the car in'));

      // Reviewing a suggestion means being able to fix it. Only completion is
      // fenced, because completion is the act that pays.
      const edited = json<Task>(
        await request(http())
          .patch(`/tasks/${draft.id}`)
          .set(asUser(userA))
          .send({ title: 'Book the car in for its MOT' })
          .expect(200),
      );

      expect(edited.title).toBe('Book the car in for its MOT');
      expect(edited.confirmedAt).toBeNull();
    });

    it('allows a draft to be moved to in_progress, which pays nothing', async () => {
      const draft = json<Task>(await createDraft(userA, 'Suggested by AI'));

      await request(http())
        .patch(`/tasks/${draft.id}`)
        .set(asUser(userA))
        .send({ status: 'in_progress' })
        .expect(200);
    });
  });

  /**
   * XP for reviewing an AI suggestion — key decision #2 in
   * docs/adhd_tracker.md, the data flywheel.
   *
   * Every assertion here reads /me/stats rather than the ledger alone, because
   * the number the user sees is the thing being promised. The ledger checks
   * sit alongside it to prove *why* it moved: a stats delta of 1 could come
   * from anything, a single `draft_reviewed` row could not.
   */
  describe('XP for reviewing a suggestion', () => {
    const createDraft = (userId: string, title: string): Promise<Response> =>
      createTask(userId, { title, source: 'ai_suggested' });

    const statsFor = async (userId: string): Promise<UserStats> =>
      json<UserStats>(await request(http()).get('/me/stats').set(asUser(userId)).expect(200));

    /** Every review payment on the user's ledger, newest last. */
    const reviewLedger = (
      userId: string,
    ): Promise<{ taskId: string | null; xpAmount: number }[]> =>
      prisma.xpEvent.findMany({
        where: { userId, type: 'draft_reviewed' },
        select: { taskId: true, xpAmount: true },
        orderBy: { id: 'asc' },
      });

    it('pays for approving a suggestion', async () => {
      const before = await statsFor(userA);
      const draft = json<Task>(await createDraft(userA, 'Book the car in'));

      await request(http()).post(`/tasks/${draft.id}/approve`).set(asUser(userA)).expect(200);

      const after = await statsFor(userA);
      expect(after.totalXp).toBe(before.totalXp + XP_DRAFT_REVIEW);
      expect(await reviewLedger(userA)).toEqual([
        { taskId: draft.id, xpAmount: XP_DRAFT_REVIEW },
      ]);
    });

    it('pays exactly the same for rejecting one', async () => {
      const before = await statsFor(userA);
      const draft = json<Task>(await createDraft(userA, 'Book the car in'));

      await request(http()).post(`/tasks/${draft.id}/reject`).set(asUser(userA)).expect(200);

      // The point of the whole decision: "that suggestion was wrong" is the
      // more useful of the two answers, so it cannot be the cheaper one. If
      // this ever drifts below approve, the app is paying users to say yes.
      const after = await statsFor(userA);
      expect(after.totalXp).toBe(before.totalXp + XP_DRAFT_REVIEW);
      expect(await reviewLedger(userA)).toEqual([
        { taskId: draft.id, xpAmount: XP_DRAFT_REVIEW },
      ]);
    });

    it('pays once no matter how many times approve is pressed', async () => {
      const before = await statsFor(userA);
      const draft = json<Task>(await createDraft(userA, 'Book the car in'));

      await request(http()).post(`/tasks/${draft.id}/approve`).set(asUser(userA)).expect(200);
      const first = await prisma.task.findUniqueOrThrow({ where: { id: draft.id } });

      await request(http()).post(`/tasks/${draft.id}/approve`).set(asUser(userA)).expect(200);
      await request(http()).post(`/tasks/${draft.id}/approve`).set(asUser(userA)).expect(200);

      const after = await statsFor(userA);
      expect(after.totalXp).toBe(before.totalXp + XP_DRAFT_REVIEW);
      // One row, not three: the guard is in the WHERE clause, so the second
      // and third calls matched nothing and never reached the ledger.
      expect(await reviewLedger(userA)).toHaveLength(1);
      // And the confirmation itself did not quietly move later either.
      const last = await prisma.task.findUniqueOrThrow({ where: { id: draft.id } });
      expect(last.confirmedAt?.toISOString()).toBe(first.confirmedAt?.toISOString());
    });

    it('pays once no matter how many times reject is pressed', async () => {
      const before = await statsFor(userA);
      const draft = json<Task>(await createDraft(userA, 'Book the car in'));

      await request(http()).post(`/tasks/${draft.id}/reject`).set(asUser(userA)).expect(200);
      await request(http()).post(`/tasks/${draft.id}/reject`).set(asUser(userA)).expect(200);

      const after = await statsFor(userA);
      expect(after.totalXp).toBe(before.totalXp + XP_DRAFT_REVIEW);
      expect(await reviewLedger(userA)).toHaveLength(1);
    });

    it('pays nothing more for approving a suggestion already rejected', async () => {
      const before = await statsFor(userA);
      const draft = json<Task>(await createDraft(userA, 'Book the car in'));

      await request(http()).post(`/tasks/${draft.id}/reject`).set(asUser(userA)).expect(200);
      const approved = json<Task>(
        await request(http()).post(`/tasks/${draft.id}/approve`).set(asUser(userA)).expect(200),
      );

      // Rejection is final: the fence opens once, in one direction. Without
      // that, reject-then-approve is a two-tap XP tap on one suggestion.
      expect(approved.status).toBe('archived');
      expect(approved.confirmedAt).toBeNull();
      const after = await statsFor(userA);
      expect(after.totalXp).toBe(before.totalXp + XP_DRAFT_REVIEW);
      expect(await reviewLedger(userA)).toHaveLength(1);
    });

    it('pays nothing for approving a task the user typed themselves', async () => {
      const before = await statsFor(userA);
      const mine = json<Task>(await createTask(userA, { title: 'Typed by hand' }));

      await request(http()).post(`/tasks/${mine.id}/approve`).set(asUser(userA)).expect(200);

      // There is no feedback in confirming your own writing, so there is
      // nothing to buy. Paying here would make the approve button a free
      // 1 XP on every manual task.
      const after = await statsFor(userA);
      expect(after.totalXp).toBe(before.totalXp);
      expect(await reviewLedger(userA)).toHaveLength(0);
    });

    it('does not let reviewing stand in for finishing something', async () => {
      const before = await statsFor(userA);
      const draft = json<Task>(await createDraft(userA, 'Book the car in'));

      await request(http()).post(`/tasks/${draft.id}/approve`).set(asUser(userA)).expect(200);

      // The streak counts days the user *did* something. If a tap on Approve
      // kept it alive, the one honest number in the app would measure
      // attendance rather than work.
      const after = await statsFor(userA);
      expect(after.currentStreak).toBe(before.currentStreak);
      expect(after.lastActiveDate).toBe(before.lastActiveDate);
    });

    it("pays nobody for reviewing another user's draft", async () => {
      const before = await statsFor(userA);
      const draft = json<Task>(await createDraft(userB, "B's suggestion"));

      await request(http()).post(`/tasks/${draft.id}/approve`).set(asUser(userA)).expect(404);

      const after = await statsFor(userA);
      expect(after.totalXp).toBe(before.totalXp);
      expect(await reviewLedger(userA)).toHaveLength(0);
      // And B's draft is untouched — the 404 was a refusal, not a silent
      // success reported as failure.
      const row = await prisma.task.findUniqueOrThrow({ where: { id: draft.id } });
      expect(row.confirmedAt).toBeNull();
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
