import {
  MAX_AUDIO_UPLOAD_BYTES,
  type HealthResponse,
  type IngestionAccepted,
} from '@adhd/shared';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { AudioIngestionQueue } from '../src/ingestion/audio-ingestion.queue.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StorageService } from '../src/storage/storage.service.js';

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

  it(
    'rejects an upload over the 25 MB cap with 413',
    async () => {
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
    },
    30_000,
  );

  it(
    'accepts an upload exactly at the cap',
    async () => {
      await request(http())
        .post('/ingestion/audio')
        .set(asUser(userA))
        .attach('file', audio(MAX_AUDIO_UPLOAD_BYTES), {
          filename: 'exact.webm',
          contentType: 'audio/webm',
        })
        .expect(202);
    },
    30_000,
  );
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

  it(
    'degrades to 503 and names storage when the bucket is unreachable',
    async () => {
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
    },
    30_000,
  );

  it('still has a working storage client afterwards', async () => {
    // Guards the env restore above: a leaked MINIO_ENDPOINT would make every
    // later suite fail for an unrelated-looking reason.
    await expect(app.get(StorageService).ping()).resolves.toBeUndefined();
  });
});
