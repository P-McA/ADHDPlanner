import {
  AUTO_RETRY_DELAYS_MS,
  isTaskDraft,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_AUTO_RETRIES,
  type HealthResponse,
  type IngestionAccepted,
  type IngestionRecord as IngestionRecordContract,
  type Task,
  type UserStats,
} from '@adhd/shared';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EXTRACTOR, TRANSCRIBER } from '../src/ai/ai.ports.js';
import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { AudioIngestionProcessor } from '../src/ingestion/audio-ingestion.processor.js';
import { AudioIngestionQueue } from '../src/ingestion/audio-ingestion.queue.js';
import { ProviderError } from '../src/ai/provider-error.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StorageService } from '../src/storage/storage.service.js';
import { FAKE_TRANSCRIPT, FakeExtractor, FakeTranscriber, timeoutError } from './fakes/ai.fakes.js';

/**
 * Voice ingestion against real Postgres, Redis and MinIO.
 *
 * The fence this suite exists to hold: an accepted upload creates an
 * `ingestion_records` row and nothing else. No task is created here — not a
 * draft, not anything — because extraction has not run. Milestone B adds the
 * worker, and even then what it produces are drafts awaiting confirmation.
 */

interface ExecutionContextLike {
  switchToHttp: () => { getRequest: () => AuthenticatedRequest };
}

let app: INestApplication;
let prisma: PrismaService;
let userA: string;
let userB: string;

/**
 * The only fakes in this suite. Everything else — Postgres, MinIO, the queue
 * rows — is real; these two stand in for the boundary that would cost money
 * and a network, and they implement the same interfaces the adapters do.
 */
const transcriber = new FakeTranscriber();
const extractor = new FakeExtractor();

const suffix = Date.now().toString(36);

const http = (): Server => app.getHttpServer() as Server;

const asUser = (userId: string): Record<string, string> => ({ 'x-test-user': userId });

/** A buffer that is not real audio — nothing in Milestone A decodes it. */
const audio = (bytes: number): Buffer => Buffer.alloc(bytes, 0x61);

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ClerkAuthGuard)
    .useValue({
      canActivate: (context: ExecutionContextLike) => {
        const req = context.switchToHttp().getRequest();
        const header = req.headers['x-test-user'];

        if (typeof header !== 'string') return false;

        req.appUser = { id: header, clerkId: `clerk_${header}` };

        return true;
      },
    })
    .overrideProvider(TRANSCRIBER)
    .useValue(transcriber)
    .overrideProvider(EXTRACTOR)
    .useValue(extractor)
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // Listen once for the whole file. Left unlistened, supertest starts and
  // closes the server around every single request; see vitest.e2e.config.ts
  // for why that surfaces as `read ECONNRESET` under a concurrent burst.
  await app.listen(0, '127.0.0.1');

  prisma = app.get(PrismaService);

  const a = await prisma.user.create({
    data: { clerkId: `clerk_ingest_a_${suffix}`, email: `ingest-a-${suffix}@test.local` },
  });
  const b = await prisma.user.create({
    data: { clerkId: `clerk_ingest_b_${suffix}`, email: `ingest-b-${suffix}@test.local` },
  });

  userA = a.id;
  userB = b.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await app.close();
});

describe('POST /ingestion/audio — accepting an upload', () => {
  it('stores the bytes, records the upload and answers 202', async () => {
    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .attach('file', audio(4096), { filename: 'memo.webm', contentType: 'audio/webm' });

    // 202, not 201: the drafts the caller actually wants do not exist yet.
    expect(res.status).toBe(202);

    const body = res.body as IngestionAccepted;
    expect(body.status).toBe('uploaded');

    const row = await prisma.ingestionRecord.findUnique({ where: { id: body.id } });
    expect(row?.userId).toBe(userA);
    expect(row?.error).toBeNull();
    // User-prefixed key, and the name is never anything the client sent.
    expect(row?.objectKey).toMatch(new RegExp(`^${userA}/[0-9a-f-]{36}\\.webm$`));
    expect(row?.objectKey).not.toContain('memo');
  });

  it('creates no task — extraction has not run and drafts need confirming', async () => {
    const before = await prisma.task.count({ where: { userId: userA } });

    await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .attach('file', audio(2048), { filename: 'a.webm', contentType: 'audio/webm' })
      .expect(202);

    // The non-negotiable fence in CLAUDE.md: nothing auto-creates tasks. If a
    // later change makes upload mint a task, this fails.
    expect(await prisma.task.count({ where: { userId: userA } })).toBe(before);
  });

  it('takes the owner from the session, not from anything the client sends', async () => {
    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .field('userId', userB)
      .attach('file', audio(1024), { filename: 'a.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(202);

    const row = await prisma.ingestionRecord.findUnique({
      where: { id: (res.body as IngestionAccepted).id },
    });
    expect(row?.userId).toBe(userA);
  });

  it('records an enqueue failure on the row rather than stranding it', async () => {
    const queue = app.get(AudioIngestionQueue);
    const enqueue = queue.enqueue.bind(queue);

    queue.enqueue = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    try {
      const res = await request(http())
        .post('/ingestion/audio')
        .set(asUser(userA))
        .attach('file', audio(1024), { filename: 'a.webm', contentType: 'audio/webm' });

      // Still 202: the bytes and the row are durable, and asking the user to
      // re-upload something the server already holds would be a lie about what
      // failed.
      expect(res.status).toBe(202);

      const row = await prisma.ingestionRecord.findUnique({
        where: { id: (res.body as IngestionAccepted).id },
      });

      // On `uploaded` this row would be indistinguishable from one whose job is
      // merely waiting its turn, and nothing would ever notice it was dropped.
      expect(row?.status).toBe('failed');
      expect(row?.error).toBe('enqueue failed: connect ECONNREFUSED 127.0.0.1:6379');
    } finally {
      queue.enqueue = enqueue;
    }
  });

  it('rejects an anonymous upload', async () => {
    await request(http())
      .post('/ingestion/audio')
      .attach('file', audio(1024), { filename: 'a.webm', contentType: 'audio/webm' })
      .expect(403);
  });
});

describe('POST /ingestion/audio — validation', () => {
  it('rejects a request with no file at all', async () => {
    await request(http()).post('/ingestion/audio').set(asUser(userA)).expect(400);
  });

  it.each([
    ['a PDF', 'application/pdf', 'notes.pdf'],
    ['an image', 'image/png', 'screenshot.png'],
    ['plain text', 'text/plain', 'notes.txt'],
    ['a video', 'video/webm', 'clip.webm'],
  ])('rejects %s with 400', async (_label, contentType, filename) => {
    const before = await prisma.ingestionRecord.count({ where: { userId: userA } });

    await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .attach('file', audio(1024), { filename, contentType })
      .expect(400);

    // Rejected before storage, so nothing is left behind in the bucket or the
    // table for a worker to pick up.
    expect(await prisma.ingestionRecord.count({ where: { userId: userA } })).toBe(before);
  });

  it('names the field it wanted and the field it got when the part is misnamed', async () => {
    const before = await prisma.ingestionRecord.count({ where: { userId: userA } });

    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      // The exact mistake the browser client made once: right bytes, right
      // content type, wrong field name. Through multer's own `single()` this
      // came back as `Unexpected field`, which names nothing.
      .attach('audio', audio(1024), { filename: 'memo.webm', contentType: 'audio/webm' })
      .expect(400);

    const message = String((res.body as { message?: unknown }).message);

    expect(message).toContain('"file"');
    expect(message).toContain('"audio"');
    // The pre-change message was `Unexpected field - audio`: it named the part
    // that arrived and nothing else, so `not.toBe('Unexpected field')` would
    // have passed against it. Pin the phrase.
    expect(message).not.toContain('Unexpected field');

    expect(await prisma.ingestionRecord.count({ where: { userId: userA } })).toBe(before);
  });

  it('asks for the audio by name when the request carried no file at all', async () => {
    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .field('title', 'no file here')
      .expect(400);

    expect(String((res.body as { message?: unknown }).message)).toContain('"file"');
  });

  it.each([
    ['audio/webm', 'memo.webm'],
    ['audio/mpeg', 'memo.mp3'],
    ['audio/mp4', 'memo.m4a'],
  ])('accepts %s', async (contentType, filename) => {
    await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .attach('file', audio(1024), { filename, contentType })
      .expect(202);
  });

  it('rejects an upload over the 25 MB cap with 413', async () => {
    const before = await prisma.ingestionRecord.count({ where: { userId: userA } });

    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .attach('file', audio(MAX_AUDIO_UPLOAD_BYTES + 1), {
        filename: 'long.webm',
        contentType: 'audio/webm',
      });

    // 413 rather than 400: the client is told to re-encode, not that it sent
    // the wrong shape. Multer would otherwise truncate at the cap and hand us
    // a valid-looking, silently corrupted memo.
    expect(res.status).toBe(413);
    expect(await prisma.ingestionRecord.count({ where: { userId: userA } })).toBe(before);
  }, 30_000);

  it('accepts an upload exactly at the cap', async () => {
    await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .attach('file', audio(MAX_AUDIO_UPLOAD_BYTES), {
        filename: 'exact.webm',
        contentType: 'audio/webm',
      })
      .expect(202);
  }, 30_000);
});

describe('ownership scoping', () => {
  let recordOfA: string;

  beforeAll(async () => {
    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .attach('file', audio(1024), { filename: 'a.webm', contentType: 'audio/webm' })
      .expect(202);

    recordOfA = (res.body as IngestionAccepted).id;
  });

  it('lets the owner read their own record', async () => {
    const res = await request(http()).get(`/ingestion/${recordOfA}`).set(asUser(userA));

    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(recordOfA);
  });

  it('answers 404, not 403, for a record belonging to someone else', async () => {
    // Same answer as a record that does not exist: ownership and existence
    // stay indistinguishable from outside, as with tasks.
    await request(http()).get(`/ingestion/${recordOfA}`).set(asUser(userB)).expect(404);
  });

  it('answers 404 for an id that does not exist', async () => {
    await request(http())
      .get('/ingestion/00000000-0000-0000-0000-000000000000')
      .set(asUser(userA))
      .expect(404);
  });

  it('rejects a malformed id before it reaches the database', async () => {
    await request(http()).get('/ingestion/not-a-uuid').set(asUser(userA)).expect(400);
  });

  it('never lists uploads belonging to another user', async () => {
    const mine = await request(http()).get('/ingestion').set(asUser(userB)).expect(200);

    expect((mine.body as { id: string }[]).map((r) => r.id)).not.toContain(recordOfA);
  });

  it('rejects anonymous reads', async () => {
    await request(http()).get('/ingestion').expect(403);
    await request(http()).get(`/ingestion/${recordOfA}`).expect(403);
  });
});

describe('GET /health with object storage', () => {
  it('reports storage healthy alongside postgres and redis', async () => {
    const res = await request(http()).get('/health').expect(200);
    const { dependencies } = res.body as HealthResponse;

    expect(dependencies.storage.status).toBe('ok');
    expect(dependencies.storage.error).toBeNull();
    // All three visible, not just the roll-up.
    expect(Object.keys(dependencies).sort()).toEqual(['postgres', 'redis', 'storage']);
  });

  it('degrades to 503 and names storage when the bucket is unreachable', async () => {
    // A separate app pointed at a closed port, rather than stopping the
    // container: the same failure the process sees when MinIO is down, but it
    // runs identically in CI, where MinIO is a workflow service that the test
    // process has no docker CLI to stop. Stopping the real container is a
    // manual check; this is the one that guards the behaviour.
    const endpoint = process.env.MINIO_ENDPOINT;
    process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const downed = moduleRef.createNestApplication();

    try {
      await downed.listen(0, '127.0.0.1');

      const res = await request(downed.getHttpServer() as Server).get('/health');

      expect(res.status).toBe(503);

      const body = res.body as HealthResponse;

      expect(body.status).toBe('error');
      expect(body.dependencies.storage.status).toBe('error');
      expect(body.dependencies.storage.error).not.toBeNull();
      // The healthy dependencies still report healthy, so the body names a
      // culprit rather than just going red.
      expect(body.dependencies.postgres.status).toBe('ok');
      expect(body.dependencies.redis.status).toBe('ok');
    } finally {
      await downed.close();

      if (endpoint === undefined) {
        delete process.env.MINIO_ENDPOINT;
      } else {
        process.env.MINIO_ENDPOINT = endpoint;
      }
    }
  }, 30_000);

  it('still has a working storage client afterwards', async () => {
    // Guards the env restore above: a leaked MINIO_ENDPOINT would make every
    // later suite fail for an unrelated-looking reason.
    await expect(app.get(StorageService).ping()).resolves.toBeUndefined();
  });
});

/**
 * The Milestone B pipeline, end to end.
 *
 * Real Postgres, real MinIO, real upload route. The queue consumer is switched
 * off (see test/load-env.ts) and the processor is driven by hand, so each test
 * asserts on a settled record rather than racing a worker for it.
 */
describe('the transcription and extraction pipeline', () => {
  function processor(): AudioIngestionProcessor {
    return app.get(AudioIngestionProcessor);
  }

  /** Uploads a memo through the real route and returns its record id. */
  async function upload(userId: string): Promise<string> {
    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userId))
      .attach('file', audio(2048), { filename: 'memo.webm', contentType: 'audio/webm' })
      .expect(202);

    return (res.body as IngestionAccepted).id;
  }

  beforeEach(() => {
    transcriber.result = () => Promise.resolve(FAKE_TRANSCRIPT);
    extractor.result = () =>
      Promise.resolve([{ title: 'Book the car in', dueAt: null, manualPriority: null }]);
    transcriber.calls.length = 0;
    extractor.calls.length = 0;
  });

  it('turns an uploaded memo into a stored transcript and a draft', async () => {
    const id = await upload(userA);

    await processor().process(id);

    const record = await prisma.ingestionRecord.findUnique({ where: { id } });
    expect(record?.status).toBe('draft_created');
    expect(record?.transcript).toBe(FAKE_TRANSCRIPT);
    expect(record?.error).toBeNull();

    // The bytes came back out of MinIO and reached the transcriber.
    expect(transcriber.calls).toHaveLength(1);
    expect(transcriber.calls[0]?.bytes).toBe(2048);
    expect(transcriber.calls[0]?.mimetype).toBe('audio/webm');

    const tasks = await prisma.task.findMany({ where: { ingestionRecordId: id } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Book the car in');
    expect(tasks[0]?.userId).toBe(userA);
  });

  it('produces drafts, not tasks — the fence holds at the end of the pipeline', async () => {
    const id = await upload(userA);

    await processor().process(id);

    const [task] = await prisma.task.findMany({ where: { ingestionRecordId: id } });

    expect(task?.source).toBe('ai_suggested');
    expect(task?.confirmedAt).toBeNull();
    // The shared predicate, not a local re-derivation: API, worker and web
    // client all answer "is this a draft" the same way, or not at all.
    expect(isTaskDraft({ source: task?.source ?? 'manual', confirmedAt: null })).toBe(true);
  });

  it('keeps the transcript when the memo held no commitment at all', async () => {
    extractor.result = () => Promise.resolve([]);
    const id = await upload(userA);

    await processor().process(id);

    const record = await prisma.ingestionRecord.findUnique({ where: { id } });
    // "We heard you and there was nothing to do" is a success, and the user
    // can check that for themselves because the transcript is still here.
    expect(record?.status).toBe('draft_created');
    expect(record?.transcript).toBe(FAKE_TRANSCRIPT);
    expect(await prisma.task.count({ where: { ingestionRecordId: id } })).toBe(0);
  });

  it('parks the record on failed when a provider call times out, once the retries are spent', async () => {
    transcriber.result = () => Promise.reject(timeoutError());
    const id = await upload(userA);

    // Must not throw: a rejection would hand the job back to BullMQ's own
    // retry, which is reserved for a crashed worker. The processor schedules
    // its own retries, MAX_AUTO_RETRIES of them, and then stops.
    for (let run = 0; run <= MAX_AUTO_RETRIES; run++) {
      await expect(processor().process(id)).resolves.toBeUndefined();
    }

    const record = await prisma.ingestionRecord.findUnique({ where: { id } });
    expect(record?.status).toBe('failed');
    expect(record?.failureKind).toBe('retryable');
    expect(record?.autoRetries).toBe(MAX_AUTO_RETRIES);
    expect(transcriber.calls).toHaveLength(MAX_AUTO_RETRIES + 1);
    expect(record?.error).toBe('The operation was aborted due to timeout');
    expect(record?.transcript).toBeNull();
    expect(await prisma.task.count({ where: { ingestionRecordId: id } })).toBe(0);
  });

  it('records an extraction failure without losing what was heard', async () => {
    extractor.result = () =>
      Promise.reject(new Error('Extraction returned 429: Rate limit reached'));
    const id = await upload(userA);

    await processor().process(id);

    const record = await prisma.ingestionRecord.findUnique({ where: { id } });
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('429');
    expect(record?.transcript).toBe(FAKE_TRANSCRIPT);
  });

  it('does not double the drafts when the same job is delivered twice', async () => {
    // Two candidates rather than one, so "exactly N" is a number a doubling bug
    // cannot land on by coincidence; and a transcript that changes on every
    // call, so a second transcription would be visible in the stored value
    // instead of overwriting it with something identical.
    extractor.result = () =>
      Promise.resolve([
        { title: 'Book the car in', dueAt: null, manualPriority: null },
        { title: 'Renew the MOT', dueAt: null, manualPriority: null },
      ]);
    let heard = 0;
    transcriber.result = () => {
      heard += 1;

      return Promise.resolve(`${FAKE_TRANSCRIPT} (heard ${String(heard)})`);
    };

    const id = await upload(userA);

    await processor().process(id);
    await processor().process(id);

    const record = await prisma.ingestionRecord.findUnique({ where: { id } });

    expect(record?.status).toBe('draft_created');
    // One transcript, and it is the first one: nothing re-heard the audio.
    expect(record?.transcript).toBe(`${FAKE_TRANSCRIPT} (heard 1)`);
    expect(await prisma.task.count({ where: { ingestionRecordId: id } })).toBe(2);
    // The second run stopped at the terminal-status guard, before any provider.
    expect(transcriber.calls).toHaveLength(1);
    expect(extractor.calls).toHaveLength(1);
  });

  it('does not double the drafts when two deliveries of one job overlap', async () => {
    // The test above is sequential, so its second run reads a finished record.
    // Here both runs are held inside transcription until both have arrived, so
    // both are already past the up-front status check — the shape of a
    // stalled-job redelivery landing while the first worker is still inside a
    // 60 s Whisper call. Only a guard on the final write can stop the second.
    extractor.result = () =>
      Promise.resolve([
        { title: 'Book the car in', dueAt: null, manualPriority: null },
        { title: 'Renew the MOT', dueAt: null, manualPriority: null },
      ]);
    let release: () => void = () => undefined;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    transcriber.result = async () => {
      if (transcriber.calls.length >= 2) release();
      await bothArrived;

      return FAKE_TRANSCRIPT;
    };

    const id = await upload(userA);

    await Promise.all([processor().process(id), processor().process(id)]);

    const record = await prisma.ingestionRecord.findUnique({ where: { id } });
    expect(transcriber.calls).toHaveLength(2);
    expect(record?.status).toBe('draft_created');
    expect(record?.error).toBeNull();
    expect(await prisma.task.count({ where: { ingestionRecordId: id } })).toBe(2);
  });

  it('resumes at extraction rather than paying to transcribe twice', async () => {
    const id = await upload(userA);
    // The state a worker killed between the two stages leaves behind.
    await prisma.ingestionRecord.update({
      where: { id },
      data: { status: 'transcribing', transcript: FAKE_TRANSCRIPT },
    });

    await processor().process(id);

    expect(transcriber.calls).toHaveLength(0);
    expect(extractor.calls).toEqual([FAKE_TRANSCRIPT]);
    expect((await prisma.ingestionRecord.findUnique({ where: { id } }))?.status).toBe(
      'draft_created',
    );
  });
});

/**
 * M2: retrying. Real Redis, so a job id BullMQ silently refuses shows up as a
 * missing job rather than a mock that agreed with whatever it was given.
 */
describe('retrying a failed memo', () => {
  function processor(): AudioIngestionProcessor {
    return app.get(AudioIngestionProcessor);
  }

  function queue(): AudioIngestionQueue {
    return app.get(AudioIngestionQueue);
  }

  async function upload(userId: string): Promise<string> {
    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userId))
      .attach('file', audio(2048), { filename: 'memo.webm', contentType: 'audio/webm' })
      .expect(202);

    return (res.body as IngestionAccepted).id;
  }

  function retry(userId: string, id: string) {
    return request(http()).post(`/ingestion/${id}/retry`).set(asUser(userId));
  }

  function workingFakes(): void {
    transcriber.result = () => Promise.resolve(FAKE_TRANSCRIPT);
    extractor.result = () =>
      Promise.resolve([{ title: 'Book the car in', dueAt: null, manualPriority: null }]);
    transcriber.calls.length = 0;
    extractor.calls.length = 0;
  }

  beforeEach(workingFakes);
  // The blocks after this one use whatever the fakes were last set to, and
  // these tests leave them failing on purpose.
  afterAll(workingFakes);

  it('schedules a delayed retry of a rate-limited call, as a job BullMQ actually holds', async () => {
    transcriber.result = () =>
      Promise.reject(ProviderError.fromStatus('Whisper returned 429: Rate limit reached', 429));
    const id = await upload(userA);

    await processor().process(id);

    const record = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(record.status).toBe('uploaded');
    expect(record.autoRetries).toBe(1);
    expect(record.error).toBe('Whisper returned 429: Rate limit reached');

    const first = await queue().getJob(id, 1);
    const next = await queue().getJob(id, record.enqueueCount);
    expect(next).toBeDefined();
    expect(next?.id).not.toBe(first?.id);
    expect(next?.opts.delay).toBe(AUTO_RETRY_DELAYS_MS[0]);
  });

  it('never retries a 400 on its own — it would be refused identically', async () => {
    transcriber.result = () =>
      Promise.reject(ProviderError.fromStatus('Whisper returned 400: Invalid file format', 400));
    const id = await upload(userA);

    await processor().process(id);

    const record = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(record.status).toBe('failed');
    expect(record.failureKind).toBe('permanent');
    expect(record.enqueueCount).toBe(1);
    expect(await queue().getJob(id, 2)).toBeUndefined();
  });

  it('lets the user retry a failed memo through to drafts, on a job BullMQ did not already hold', async () => {
    transcriber.result = () =>
      Promise.reject(ProviderError.fromStatus('Whisper returned 400: Invalid file format', 400));
    const id = await upload(userA);
    await processor().process(id);
    const firstJob = await queue().getJob(id, 1);

    // The fix ships; the user presses Retry.
    transcriber.result = () => Promise.resolve(FAKE_TRANSCRIPT);
    const res = await retry(userA, id).expect(202);
    const body = res.body as IngestionRecordContract;
    expect(body.status).toBe('uploaded');
    expect(body.error).toBeNull();
    expect(body.failureKind).toBeNull();

    // The finished first job is still in Redis (kept an hour), so a retry that
    // reused its id would be silently dropped. This is the job that must exist.
    const claimed = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    const retryJob = await queue().getJob(id, claimed.enqueueCount);
    expect(retryJob).toBeDefined();
    expect(retryJob?.id).not.toBe(firstJob?.id);

    await processor().process(id);

    const record = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(record.status).toBe('draft_created');
    expect(await prisma.task.count({ where: { ingestionRecordId: id } })).toBe(1);
  });

  it('resumes at extraction on a retry, rather than paying Whisper twice', async () => {
    extractor.result = () =>
      Promise.reject(ProviderError.fromStatus('Extraction returned 400: bad request', 400));
    const id = await upload(userA);
    await processor().process(id);
    expect(transcriber.calls).toHaveLength(1);

    extractor.result = () =>
      Promise.resolve([{ title: 'Book the car in', dueAt: null, manualPriority: null }]);
    await retry(userA, id).expect(202);
    await processor().process(id);

    expect(transcriber.calls).toHaveLength(1);
    const record = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(record.status).toBe('draft_created');
  });

  it('starts one run for two taps, not two', async () => {
    transcriber.result = () =>
      Promise.reject(ProviderError.fromStatus('Whisper returned 400: no', 400));
    const id = await upload(userA);
    await processor().process(id);

    const [a, b] = await Promise.all([retry(userA, id), retry(userA, id)]);

    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const record = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(record.enqueueCount).toBe(2);
  });

  it('409s on a memo that did not fail, and leaves it alone', async () => {
    const id = await upload(userA);
    await processor().process(id);

    await retry(userA, id).expect(409);

    const record = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(record.status).toBe('draft_created');
    expect(record.enqueueCount).toBe(1);
  });

  it('409s on an erased memo — erasing wins over retrying', async () => {
    transcriber.result = () =>
      Promise.reject(ProviderError.fromStatus('Whisper returned 400: no', 400));
    const id = await upload(userA);
    await processor().process(id);
    await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(200);

    await retry(userA, id).expect(409);

    const record = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(record.status).toBe('failed');
    expect(await queue().getJob(id, 2)).toBeUndefined();
  });

  it('404s on another user’s memo, and runs nothing', async () => {
    transcriber.result = () =>
      Promise.reject(ProviderError.fromStatus('Whisper returned 400: no', 400));
    const id = await upload(userA);
    await processor().process(id);

    await retry(userB, id).expect(404);

    const record = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(record.status).toBe('failed');
    expect(record.enqueueCount).toBe(1);
  });
});

describe('confirming and rejecting drafts', () => {
  /** A memo processed through to a single draft, returned with its task id. */
  async function draftFor(userId: string): Promise<{ recordId: string; taskId: string }> {
    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userId))
      .attach('file', audio(1024), { filename: 'memo.webm', contentType: 'audio/webm' })
      .expect(202);

    const recordId = (res.body as IngestionAccepted).id;
    await app.get(AudioIngestionProcessor).process(recordId);

    const [task] = await prisma.task.findMany({ where: { ingestionRecordId: recordId } });

    return { recordId, taskId: task?.id ?? '' };
  }

  it('stops being a draft once the user approves it', async () => {
    const { taskId } = await draftFor(userA);

    const before = await request(http()).get(`/tasks/${taskId}`).set(asUser(userA)).expect(200);
    expect(isTaskDraft(before.body as Task)).toBe(true);

    const res = await request(http())
      .post(`/tasks/${taskId}/approve`)
      .set(asUser(userA))
      .expect(200);

    const approved = res.body as Task;
    expect(approved.confirmedAt).not.toBeNull();
    expect(approved.source).toBe('ai_suggested');
    // Provenance survives confirmation; draftness does not. Badging on source
    // alone would mark this an unreviewed suggestion forever.
    expect(isTaskDraft(approved)).toBe(false);
  });

  it('is idempotent — a second approve does not move the timestamp', async () => {
    const { taskId } = await draftFor(userA);

    const first = await request(http())
      .post(`/tasks/${taskId}/approve`)
      .set(asUser(userA))
      .expect(200);
    const second = await request(http())
      .post(`/tasks/${taskId}/approve`)
      .set(asUser(userA))
      .expect(200);

    expect((second.body as Task).confirmedAt).toBe((first.body as Task).confirmedAt);
  });

  it('archives a rejected draft and leaves it unconfirmed', async () => {
    const { taskId } = await draftFor(userA);

    const res = await request(http())
      .post(`/tasks/${taskId}/reject`)
      .set(asUser(userA))
      .expect(200);

    const rejected = res.body as Task;
    expect(rejected.status).toBe('archived');
    expect(rejected.confirmedAt).toBeNull();
  });

  it('cannot be confirmed through PATCH, only through the approve route', async () => {
    const { taskId } = await draftFor(userA);

    // UpdateTaskInput carries neither field, and the DTO whitelist rejects
    // both — confirmation is an act, not something that rides along in a save.
    await request(http())
      .patch(`/tasks/${taskId}`)
      .set(asUser(userA))
      .send({ confirmedAt: new Date().toISOString(), source: 'manual' })
      .expect(400);

    const row = await prisma.task.findUnique({ where: { id: taskId } });
    expect(row?.confirmedAt).toBeNull();
    expect(row?.source).toBe('ai_suggested');
  });

  it('404s rather than 403s when the draft belongs to someone else', async () => {
    const { taskId } = await draftFor(userA);

    await request(http()).post(`/tasks/${taskId}/approve`).set(asUser(userB)).expect(404);

    const row = await prisma.task.findUnique({ where: { id: taskId } });
    expect(row?.confirmedAt).toBeNull();
  });
});

/**
 * Erasing a memo: `DELETE /ingestion/:id`.
 *
 * The bucket is real MinIO here, not a stubbed StorageService, and that is the
 * point of the suite. The claim being made is "the object is gone from the
 * bucket" — a stub would only prove the service called a method named
 * `remove`, which is the mock-the-boundary error recorded in CLAUDE.md. The
 * proof is a `get` on the key afterwards that fails.
 */
describe('erasing a memo', () => {
  const storage = (): StorageService => app.get(StorageService);

  beforeEach(() => {
    transcriber.result = () => Promise.resolve(FAKE_TRANSCRIPT);
    extractor.result = () =>
      Promise.resolve([
        { title: 'Book the car in', dueAt: null, manualPriority: null },
        { title: 'Renew the MOT', dueAt: null, manualPriority: null },
      ]);
    transcriber.calls.length = 0;
    extractor.calls.length = 0;
  });

  /** An uploaded, fully processed memo with two drafts hanging off it. */
  async function processedMemo(userId: string): Promise<{ id: string; objectKey: string }> {
    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userId))
      .attach('file', audio(1024), { filename: 'memo.webm', contentType: 'audio/webm' })
      .expect(202);

    const id = (res.body as IngestionAccepted).id;
    await app.get(AudioIngestionProcessor).process(id);

    const row = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });

    return { id, objectKey: row.objectKey };
  }

  it('removes the object from the bucket', async () => {
    const { id, objectKey } = await processedMemo(userA);

    // It is really there first, or "gone" afterwards proves nothing.
    await expect(storage().get(objectKey)).resolves.toMatchObject({ contentType: 'audio/webm' });

    await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(200);

    await expect(storage().get(objectKey)).rejects.toThrow();
  });

  it('leaves the record inspectable, with the account of what happened to it', async () => {
    const { id } = await processedMemo(userA);

    await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(200);

    const res = await request(http()).get(`/ingestion/${id}`).set(asUser(userA)).expect(200);
    const record = res.body as IngestionRecordContract;

    expect(record.deletedAt).not.toBeNull();
    // Status and error survive: they are the only remaining account of an
    // object that no longer exists.
    expect(record.status).toBe('draft_created');
    // The transcript does not. It is a copy of what the audio said, and
    // erasing the audio while keeping it would erase nothing.
    expect(record.transcript).toBeNull();
  });

  it('drops it from the uploads list', async () => {
    const { id } = await processedMemo(userA);
    const kept = await processedMemo(userA);

    await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(200);

    const res = await request(http()).get('/ingestion').set(asUser(userA)).expect(200);
    const ids = (res.body as IngestionRecordContract[]).map((row) => row.id);

    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(id);
  });

  it('deletes the drafts nobody confirmed', async () => {
    const { id } = await processedMemo(userA);
    expect(await prisma.task.count({ where: { ingestionRecordId: id } })).toBe(2);

    const res = await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(200);

    expect(res.body).toEqual({ id, deletedDrafts: 2 });
    expect(await prisma.task.count({ where: { ingestionRecordId: id } })).toBe(0);
  });

  it('keeps a suggestion the user approved, and the XP it paid', async () => {
    const { id } = await processedMemo(userA);
    const [adopted, untouched] = await prisma.task.findMany({
      where: { ingestionRecordId: id },
      orderBy: { title: 'asc' },
    });

    await request(http())
      .post(`/tasks/${adopted?.id ?? ''}/approve`)
      .set(asUser(userA))
      .expect(200);
    const before = (await request(http()).get('/me/stats').set(asUser(userA)).expect(200))
      .body as UserStats;

    const res = await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(200);

    // An approved suggestion stopped being the memo's the moment a human
    // adopted it. Only the one still awaiting review goes.
    expect(res.body).toEqual({ id, deletedDrafts: 1 });
    expect(await prisma.task.findUnique({ where: { id: adopted?.id ?? '' } })).not.toBeNull();
    expect(await prisma.task.findUnique({ where: { id: untouched?.id ?? '' } })).toBeNull();

    // And the XP is untouched — including the 1 XP the *rejected*-or-deleted
    // draft's sibling earned at approval.
    const after = (await request(http()).get('/me/stats').set(asUser(userA)).expect(200))
      .body as UserStats;
    expect(after.totalXp).toBe(before.totalXp);
  });

  it('stays erased when the delete lands while the memo is being transcribed', async () => {
    // The erase arrives mid-pipeline: after the audio was read, before the
    // transcript is written back. Without a guard on that write the
    // transcript returns to the erased row and drafts follow it.
    let id = '';
    transcriber.result = async () => {
      await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(200);

      return FAKE_TRANSCRIPT;
    };
    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .attach('file', audio(1024), { filename: 'memo.webm', contentType: 'audio/webm' })
      .expect(202);
    id = (res.body as IngestionAccepted).id;

    await expect(app.get(AudioIngestionProcessor).process(id)).resolves.toBeUndefined();

    const record = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(record.deletedAt).not.toBeNull();
    expect(record.transcript).toBeNull();
    expect(record.status).not.toBe('draft_created');
    expect(await prisma.task.count({ where: { ingestionRecordId: id } })).toBe(0);
    // It stopped at the write that would have restored the transcript, so the
    // paid extraction call never happened either.
    expect(extractor.calls).toHaveLength(0);
  });

  it('never processes a memo erased while its job was still waiting', async () => {
    const res = await request(http())
      .post('/ingestion/audio')
      .set(asUser(userA))
      .attach('file', audio(1024), { filename: 'memo.webm', contentType: 'audio/webm' })
      .expect(202);
    const id = (res.body as IngestionAccepted).id;

    await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(200);
    await app.get(AudioIngestionProcessor).process(id);

    const record = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    // Left exactly as the erase left it — not `failed` with a storage error
    // about an object the user deliberately removed.
    expect(record.status).toBe('uploaded');
    expect(record.error).toBeNull();
    expect(transcriber.calls).toHaveLength(0);
  });

  it('is a no-op the second time, and does not restamp the deletion', async () => {
    const { id } = await processedMemo(userA);

    await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(200);
    const first = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });

    const res = await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(200);

    expect(res.body).toEqual({ id, deletedDrafts: 0 });
    const second = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(second.deletedAt?.toISOString()).toBe(first.deletedAt?.toISOString());
  });

  it("404s rather than 403s on another user's memo, and erases nothing", async () => {
    const { id, objectKey } = await processedMemo(userB);

    await request(http()).delete(`/ingestion/${id}`).set(asUser(userA)).expect(404);

    // The refusal has to be real, not a success reported as a failure: the
    // object, the row and B's drafts are all still there.
    await expect(storage().get(objectKey)).resolves.toMatchObject({ contentType: 'audio/webm' });
    const row = await prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).toBeNull();
    expect(await prisma.task.count({ where: { ingestionRecordId: id } })).toBe(2);
  });
});
