import { isTaskDraft, predictionReason, type Task, type TaskPage } from '@adhd/shared';
import { type ExecutionContext, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EMBEDDER } from '../src/ai/ai.ports.js';
import { ProviderError } from '../src/ai/provider-error.js';
import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakeEmbedder } from './fakes/ai.fakes.js';

/**
 * "Suggest tasks", end to end: real routes, real Postgres *with pgvector*, the
 * embedding model replaced at its port by {@link FakeEmbedder} — a bag of
 * words, so which titles count as similar is predictable from the words.
 *
 * The prediction is what usually came next: for an open or recently finished
 * task, find similar tasks finished in the past, and offer what was finished
 * within a week after them. What only a real database can show is pinned
 * here: the vector search, the follow-on window, the dedupe against what the
 * user already has, the draft fence, and that only new or changed tasks are
 * sent to the model.
 */
describe('Suggest tasks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userA: string;
  let userB: string;
  const embedder = new FakeEmbedder();

  const suffix = Date.now().toString(36);
  const http = (): Server => app.getHttpServer() as Server;
  const json = <T>(res: Response): T => res.body as T;
  const asUser = (userId: string): Record<string, string> => ({ 'x-test-user': userId });
  const daysAgo = (days: number): Date => new Date(Date.now() - days * 86_400_000);

  const predict = (userId: string) => request(http()).post('/predictions').set(asUser(userId));

  /** A task the user typed and finished `days` ago. */
  const done = (userId: string, title: string, days: number) =>
    prisma.task.create({
      data: { userId, title, source: 'manual', status: 'done', completedAt: daysAgo(days) },
    });

  /** A task the user typed and has not finished. */
  const open = (userId: string, title: string) =>
    prisma.task.create({ data: { userId, title, source: 'manual' } });

  /** History: did `past` 60 days ago, then `next` two days later. */
  async function history(userId: string, past: string, next: string): Promise<void> {
    await done(userId, past, 60);
    await done(userId, next, 58);
  }

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
      .overrideProvider(EMBEDDER)
      .useValue(embedder)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');

    prisma = app.get(PrismaService);

    const [a, b] = await Promise.all([
      prisma.user.create({
        data: { clerkId: `clerk_pred_a_${suffix}`, email: `pred_a_${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { clerkId: `clerk_pred_b_${suffix}`, email: `pred_b_${suffix}@test.local` },
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
    embedder.calls.length = 0;
    embedder.failWith = null;
  });

  it('suggests what came next after a similar past task, as a draft that says why', async () => {
    await history(userA, 'Book the MOT', 'Pay for the MOT');
    await open(userA, 'Book the MOT');

    const res = await predict(userA).expect(201);
    const drafts = json<Task[]>(res);

    expect(drafts.map((task) => task.title)).toEqual(['Pay for the MOT']);
    expect(drafts[0]).toMatchObject({
      source: 'ai_suggested',
      confirmedAt: null,
      parentTaskId: null,
      suggestionReason: predictionReason('Book the MOT'),
    });
    expect(isTaskDraft(drafts[0]!)).toBe(true);
  });

  it('suggests nothing when there is no history to learn from', async () => {
    await open(userA, 'Book the MOT');

    const res = await predict(userA).expect(201);

    expect(json<Task[]>(res)).toEqual([]);
  });

  it('only counts what came within a week after the past task', async () => {
    await done(userA, 'Book the MOT', 60);
    await done(userA, 'Pay for the MOT', 50); // ten days later: not a follow-on
    await open(userA, 'Book the MOT');

    expect(json<Task[]>(await predict(userA).expect(201))).toEqual([]);
  });

  it('ignores past tasks that are not similar to anything current', async () => {
    await history(userA, 'Water the garden', 'Pay for the MOT');
    await open(userA, 'Book the MOT');

    expect(json<Task[]>(await predict(userA).expect(201))).toEqual([]);
  });

  it('does not suggest what the user already has open, or finished recently', async () => {
    await history(userA, 'Book the MOT', 'Pay for the MOT');
    await history(userA, 'Book the dentist', 'Go to the dentist');
    await open(userA, 'Book the MOT');
    await open(userA, 'Book the dentist');
    await open(userA, 'pay for the MOT.'); // the same task, differently typed
    await done(userA, 'Go to the dentist', 3);

    expect(json<Task[]>(await predict(userA).expect(201))).toEqual([]);
  });

  it('drops a near-identical rewording that the exact-title check would miss', async () => {
    // Only the embedding half of the dedupe can catch this one: the titles
    // differ, the words nearly do not (fake cosine ≈ 0.866, over the cut-off).
    await history(userA, 'Book the MOT', 'Pay for the MOT');
    await open(userA, 'Book the MOT');
    await open(userA, 'Pay for MOT');

    expect(json<Task[]>(await predict(userA).expect(201))).toEqual([]);
  });

  it('does not offer again what the user just rejected', async () => {
    // A rejection is an answer. Re-offering it on the next press would make
    // the user say no twice for the same thing — the review XP is paid once.
    await history(userA, 'Book the MOT', 'Pay for the MOT');
    await open(userA, 'Book the MOT');
    const [draft] = json<Task[]>(await predict(userA).expect(201));
    await request(http()).post(`/tasks/${draft!.id}/reject`).set(asUser(userA)).expect(200);

    expect(json<Task[]>(await predict(userA).expect(201))).toEqual([]);
  });

  it('offers at most three, the best-supported first', async () => {
    await open(userA, 'Plan the party');
    // "Send the invites" followed a party twice; the rest once each.
    await history(userA, 'Plan the party', 'Send the invites');
    await done(userA, 'Plan the party', 90);
    await done(userA, 'Send the invites', 89);
    for (const next of ['Buy balloons', 'Order a cake', 'Book a venue']) {
      await done(userA, next, 57);
    }

    const titles = json<Task[]>(await predict(userA).expect(201)).map((task) => task.title);

    expect(titles).toHaveLength(3);
    expect(titles[0]).toBe('Send the invites');
  });

  it('409s while earlier suggestions are unreviewed, without asking the model again', async () => {
    await history(userA, 'Book the MOT', 'Pay for the MOT');
    await open(userA, 'Book the MOT');
    await predict(userA).expect(201);
    const calls = embedder.calls.length;

    await predict(userA).expect(409);

    expect(embedder.calls).toHaveLength(calls);
  });

  it('embeds only what is new or changed since the last press', async () => {
    await history(userA, 'Book the MOT', 'Pay for the MOT');
    const anchor = await open(userA, 'Book the MOT');
    const [draft] = json<Task[]>(await predict(userA).expect(201));
    await request(http()).post(`/tasks/${draft!.id}/reject`).set(asUser(userA)).expect(200);
    embedder.calls.length = 0;
    await prisma.task.update({ where: { id: anchor.id }, data: { title: 'Book the MOT test' } });
    await open(userA, 'Clean the car');

    await predict(userA).expect(201);

    // Only the renamed task and the new one — never the whole history again.
    expect(embedder.calls.flat().sort()).toEqual(['Book the MOT test', 'Clean the car']);
  });

  it('answers 502 with the reason when the model fails, and writes nothing', async () => {
    await history(userA, 'Book the MOT', 'Pay for the MOT');
    await open(userA, 'Book the MOT');
    embedder.failWith = new ProviderError('Embedding returned 500: boom', 'retryable');

    const res = await predict(userA).expect(502);

    expect(json<{ message: string }>(res).message).toContain('Embedding returned 500: boom');
    expect(await prisma.task.count({ where: { userId: userA, source: 'ai_suggested' } })).toBe(0);
  });

  it('never learns from another user’s history', async () => {
    await history(userB, 'Book the MOT', 'Pay for the MOT');
    // B presses too, so B's history is embedded. Without this the test passed
    // even with the user filter removed — B's rows had no vectors to join.
    await predict(userB).expect(201);
    await open(userA, 'Book the MOT');

    expect(json<Task[]>(await predict(userA).expect(201))).toEqual([]);
  });

  it('keeps the suggestions behind the draft fence, and pays the usual review XP', async () => {
    await history(userA, 'Book the MOT', 'Pay for the MOT');
    await open(userA, 'Book the MOT');
    const [draft] = json<Task[]>(await predict(userA).expect(201));

    const plain = json<TaskPage>(await request(http()).get('/tasks').set(asUser(userA)).expect(200));
    const withDrafts = json<TaskPage>(
      await request(http()).get('/tasks').query({ include: 'drafts' }).set(asUser(userA)).expect(200),
    );
    expect(plain.items.map((task) => task.id)).not.toContain(draft!.id);
    expect(withDrafts.items.find((task) => task.id === draft!.id)?.suggestionReason).toBe(
      predictionReason('Book the MOT'),
    );

    await request(http()).post(`/tasks/${draft!.id}/approve`).set(asUser(userA)).expect(200);

    const ledger = await prisma.xpEvent.findMany({ where: { userId: userA, type: 'draft_reviewed' } });
    expect(ledger.map((row) => row.xpAmount)).toEqual([1]);
  });
});
