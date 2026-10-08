import { AUDIO_UPLOAD_FIELD } from '@adhd/shared';
import { clerkMiddleware } from '@clerk/express';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo, Server } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DECOMPOSER, EXTRACTOR, TRANSCRIBER } from '../src/ai/ai.ports.js';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FAKE_STEPS, FakeDecomposer, FakeExtractor, FakeTranscriber } from './fakes/ai.fakes.js';

import * as mobile from '../../mobile/src/lib/api-client.js';

/**
 * The mobile client, run against the real API.
 *
 * This file is the point of the whole mobile milestone. `apps/mobile` could
 * have been proved entirely with React Native Testing Library over a stubbed
 * `fetch` — and that would have proved nothing, in exactly the way the draft
 * fence was once "proved" by a Jest test rendering `task-dashboard.tsx` against
 * a fixture. See CLAUDE.md: a test that mocks the boundary it is meant to be
 * proving will always agree with you.
 *
 * So the mobile `api-client` module is deliberately free of React Native
 * imports, and here it is imported directly, pointed at a real Nest app on a
 * real port, in front of real Postgres. What is under test is the phone's own
 * code: its URLs, its query string, its headers, its multipart body, its error
 * mapping.
 *
 * The cross-package relative import is the price of that, and it is worth it.
 * The alternative — a workspace dependency from the API onto the mobile app —
 * would invert the dependency direction for the sake of tidiness.
 *
 * **The unmocked guard.** Every other e2e suite here overrides
 * `ClerkAuthGuard` with a fake that reads `x-test-user`. This one does not: it
 * arms `DEV_AUTH_BYPASS` and lets the genuine guard read the `x-dev-user`
 * header the mobile client sends. The claim being made in CLAUDE.md is that
 * mobile's dev sign-in is *server-gated*, and a fake guard cannot support that
 * claim — only the real one can.
 *
 * What this cannot reach: React Native's marshalling of a `{uri,name,type}`
 * part into a file, which happens in native code on a device. Node has no
 * equivalent, so the upload test hands the same function a `Blob`. Everything
 * the API contracts on — path, method, field name, headers — is the same code.
 */

let app: INestApplication;
let prisma: PrismaService;

const label = `mob${Date.now().toString(36)}`.slice(0, 32);

/** The user id the guard provisions for our dev label, resolved in beforeAll. */
let userId: string;

beforeAll(async () => {
  // Read by the real guard. Arming it here rather than in load-env.ts keeps
  // every other suite on the fail-closed path.
  process.env.DEV_AUTH_BYPASS = 'true';

  // Deliberately fake, and set before the middleware is constructed — it reads
  // them then. A real key would change no assertion here and would only make
  // the suite depend on a live tenant. Same values as auth.e2e-spec.
  process.env.CLERK_TELEMETRY_DISABLED = '1';
  process.env.CLERK_SECRET_KEY ||= 'sk_test_0000000000000000000000000000000000000000';
  process.env.CLERK_PUBLISHABLE_KEY ||=
    'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TRANSCRIBER)
    .useValue(new FakeTranscriber())
    .overrideProvider(EXTRACTOR)
    .useValue(new FakeExtractor())
    .overrideProvider(DECOMPOSER)
    .useValue(new FakeDecomposer())
    .compile();

  app = moduleRef.createNestApplication();
  // Mirrors main.ts, and it matters here more than anywhere: with the bypass
  // disarmed the guard falls through to `getAuth`, which *throws* rather than
  // returning an empty session when the middleware was never mounted. An app
  // assembled without it answers 500 to an unauthenticated request instead of
  // 401 — the wrong answer, and not the one this suite should be pinning.
  app.use(clerkMiddleware());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));

  await app.init();
  await app.listen(0, '127.0.0.1');

  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;

  // Exactly what a device would be configured with, and the same variable the
  // Expo bundler inlines: `EXPO_PUBLIC_API_URL`.
  process.env.EXPO_PUBLIC_API_URL = `http://127.0.0.1:${String(port)}`;
  process.env.EXPO_PUBLIC_DEV_MODE = 'true';
  process.env.EXPO_PUBLIC_DEV_USER = label;

  prisma = app.get(PrismaService);

  // One authenticated call to make the guard provision the row, then read the
  // id it chose — the client never sees a user id, only a label.
  await mobile.getStats();

  const user = await prisma.user.findFirstOrThrow({ where: { clerkId: `dev_${label}` } });

  userId = user.id;
});

afterAll(async () => {
  // Files share a process (`fileParallelism: false`, no per-file isolation),
  // so an armed bypass left behind would be a global change made by one suite.
  delete process.env.DEV_AUTH_BYPASS;

  await prisma.xpEvent.deleteMany({ where: { userId } });
  await prisma.task.deleteMany({ where: { userId } });
  await prisma.ingestionRecord.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });

  await app.close();
});

beforeEach(async () => {
  await prisma.xpEvent.deleteMany({ where: { userId } });
  await prisma.task.deleteMany({ where: { userId } });
});

/** A live task, as if the user had typed it. */
async function typedTask(title: string): Promise<string> {
  const task = await prisma.task.create({ data: { userId, title, source: 'manual' } });

  return task.id;
}

/** An unconfirmed AI draft — the thing the server fence hides by default. */
async function draft(title: string): Promise<string> {
  const task = await prisma.task.create({
    data: { userId, title, source: 'ai_suggested', confirmedAt: null },
  });

  return task.id;
}

describe('the mobile client against the real API', () => {
  it('signs in with the dev header, through the guard that decides whether to trust it', async () => {
    const stats = await mobile.getStats();

    // Not the fake guard every other suite installs: the request went through
    // ClerkAuthGuard itself, which provisioned this user from the header only
    // because DEV_AUTH_BYPASS is armed server-side.
    expect(stats.totalXp).toBe(0);
    expect(stats.level).toBeGreaterThanOrEqual(1);
  });

  it('is refused when the server has not armed the bypass, whatever the client sends', async () => {
    process.env.DEV_AUTH_BYPASS = 'false';

    try {
      // The client is unchanged and still sending `x-dev-user`. The flag that
      // matters is the server's, which is the entire claim being made about
      // this sign-in path.
      await expect(mobile.getStats()).rejects.toMatchObject({ status: 401 });
    } finally {
      process.env.DEV_AUTH_BYPASS = 'true';
    }
  });

  it('sends no dev header at all when the client-side flag is off', async () => {
    process.env.EXPO_PUBLIC_DEV_MODE = 'false';

    try {
      expect(mobile.devModeEnabled()).toBe(false);
      await expect(mobile.getStats()).rejects.toMatchObject({ status: 401 });
    } finally {
      process.env.EXPO_PUBLIC_DEV_MODE = 'true';
    }
  });

  it('lists the tasks the phone is meant to see', async () => {
    await typedTask('buy milk');

    const page = await mobile.listTasks();

    expect(page.items.map((task) => task.title)).toContain('buy milk');
  });

  it('completes a task and earns the XP the server decides on', async () => {
    const id = await typedTask('take the bins out');

    const completed = await mobile.completeTask(id);

    expect(completed.status).toBe('done');

    // Not asserted as 10 by the client: the amount is the server's business,
    // and the phone displays whatever the ledger says.
    const stats = await mobile.getStats();

    expect(stats.totalXp).toBeGreaterThan(0);
    expect(stats.currentStreak).toBeGreaterThanOrEqual(1);
  });

  it('reads the badges a completion earned, named from the shared definitions', async () => {
    await mobile.completeTask(await typedTask('water the plants'));

    const badges = await mobile.getBadges();
    const firstWin = badges.find((badge) => badge.key === 'first_task_done');

    expect(firstWin?.name).toBe('First win');
    expect(Number.isNaN(Date.parse(firstWin?.awardedAt ?? ''))).toBe(false);
  });

  it('does not get drafts back from the plain list — the fence is the server’s', async () => {
    await draft('something the AI heard');

    const page = await mobile.listTasks();

    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
  });

  it('serves the phone its drafts only when it asks for them', async () => {
    await draft('something the AI heard');

    // `listDrafts()` is the only thing that changed. If the mobile suggestions
    // view ever stops calling it, this test goes red — which is the whole
    // reason the opt-in is a named function rather than a flag on a screen.
    const page = await mobile.listDrafts();

    expect(page.items.map((task) => task.title)).toEqual(['something the AI heard']);
  });

  it('adds a suggestion to the phone’s tasks through the approve route', async () => {
    const id = await draft('call the dentist');

    // What "Add to tasks" sends. Before it existed the phone could only offer a
    // disabled Done, because completing an unconfirmed draft is a 409.
    await expect(mobile.completeTask(id)).rejects.toMatchObject({ status: 409 });

    const approved = await mobile.approveTask(id);

    expect(approved.confirmedAt).not.toBeNull();
    // Out of the fenced suggestions and into the ordinary list…
    expect((await mobile.listTasks()).items.map((task) => task.id)).toContain(id);
    // …where Done now works, which is the button the user expected to press.
    await expect(mobile.completeTask(id)).resolves.toMatchObject({ status: 'done' });
  });

  it('breaks a task into steps, lists them, and adds or rejects each through the phone’s own calls', async () => {
    const id = await typedTask('book the MOT');

    const suggested = await mobile.breakIntoSteps(id);

    // Drafts under the parent, in the model's order — nothing confirmed for the user.
    expect(suggested.map((step) => step.title)).toEqual(FAKE_STEPS.map((step) => step.title));
    expect(suggested.every((step) => step.parentTaskId === id && step.confirmedAt === null)).toBe(
      true,
    );
    // A second press while those are unreviewed is a 409 the phone can show.
    await expect(mobile.breakIntoSteps(id)).rejects.toMatchObject({ status: 409 });

    const [first, second] = suggested;
    await mobile.approveTask(first!.id);
    await mobile.rejectTask(second!.id);

    // The rejected step leaves the list; the added one stays, now confirmed.
    const listed = await mobile.listSteps(id);
    expect(listed.map((step) => step.id)).not.toContain(second!.id);
    expect(listed.find((step) => step.id === first!.id)?.confirmedAt).not.toBeNull();
    // An added step has an ordinary Done.
    await expect(mobile.completeTask(first!.id)).resolves.toMatchObject({ status: 'done' });
    // Steps never appear in the phone's main list, drafts included.
    expect((await mobile.listDrafts()).items.map((task) => task.id)).toEqual([id]);
  });

  it('retries a failed memo through the route the Retry button calls', async () => {
    const bytes = new Blob([new Uint8Array(1024).fill(0x61)], { type: 'audio/webm' });
    const { id } = await mobile.uploadVoiceMemo(bytes, 'memo.webm');
    await prisma.ingestionRecord.update({
      where: { id },
      data: { status: 'failed', error: 'Whisper returned 400: no', failureKind: 'permanent' },
    });

    const retried = await mobile.retryIngestion(id);

    // Back in the queue, clean, and readable by the same poll the phone uses.
    expect(retried).toMatchObject({ id, status: 'uploaded', error: null, failureKind: null });
    await expect(mobile.getIngestionRecord(id)).resolves.toMatchObject({ status: 'uploaded' });
    // A second tap is a 409 the phone can show, not a second run.
    await expect(mobile.retryIngestion(id)).rejects.toMatchObject({ status: 409 });
  });

  it('uploads a memo under the field name both ends read from the contract', async () => {
    const bytes = new Blob([new Uint8Array(1024).fill(0x61)], { type: 'audio/webm' });

    const accepted = await mobile.uploadVoiceMemo(bytes, 'memo.webm');

    // 202 and a record id: queued, not transcribed, and certainly not a task.
    expect(accepted.status).toBe('uploaded');

    const record = await prisma.ingestionRecord.findUniqueOrThrow({
      where: { id: accepted.id },
    });

    expect(record.userId).toBe(userId);
    expect(await prisma.task.count({ where: { userId } })).toBe(0);
  });

  it('would be told exactly what to fix if it ever sent the wrong field name', async () => {
    // Not reachable through `uploadVoiceMemo`, which reads the name from
    // `@adhd/shared` — this is the API's half of that guarantee, exercised the
    // way a hand-rolled client would hit it.
    const form = new FormData();

    form.append('audio', new Blob([new Uint8Array(64)], { type: 'audio/webm' }), 'memo.webm');

    const response = await fetch(`${mobile.apiBaseUrl()}/ingestion/audio`, {
      method: 'POST',
      body: form,
      headers: { 'x-dev-user': label },
    });

    expect(response.status).toBe(400);

    const body = (await response.json()) as { message?: string };

    expect(body.message).toContain(`"${AUDIO_UPLOAD_FIELD}"`);
    expect(body.message).toContain('"audio"');
  });

  it('reports an unreachable API as a reachability failure, not an empty account', async () => {
    const good = process.env.EXPO_PUBLIC_API_URL;

    // Port 1 — nothing listens there. The phone's most common failure by a
    // wide margin, and it must not look like "you have no tasks".
    process.env.EXPO_PUBLIC_API_URL = 'http://127.0.0.1:1';

    try {
      await expect(mobile.listTasks()).rejects.toMatchObject({ status: 0 });
    } finally {
      process.env.EXPO_PUBLIC_API_URL = good;
    }
  });
});
