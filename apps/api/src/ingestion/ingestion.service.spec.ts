import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IngestionService } from './ingestion.service.js';
import type { UploadedAudio } from './audio-upload.validation.js';

/**
 * The ordering guarantees of accepting an upload. These are the properties a
 * crashed request has to leave behind: bytes before row, row before job, and
 * an unreachable queue that does not lose the upload.
 */

const USER_ID = '11111111-1111-1111-1111-111111111111';
const RECORD_ID = '22222222-2222-2222-2222-222222222222';

const file: UploadedAudio = {
  fieldname: 'file',
  mimetype: 'audio/webm',
  size: 2048,
  buffer: Buffer.from('fake audio'),
};

describe('IngestionService.acceptAudio', () => {
  let calls: string[];
  let put: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let enqueue: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let service: IngestionService;

  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: RECORD_ID,
    userId: USER_ID,
    objectKey: `${USER_ID}/abc.webm`,
    status: 'uploaded',
    transcript: null,
    error: null,
    failureKind: null,
    autoRetries: 0,
    enqueueCount: 1,
    createdAt: new Date('2026-09-08T10:00:00.000Z'),
    updatedAt: new Date('2026-09-08T10:00:00.000Z'),
    ...over,
  });

  beforeEach(() => {
    calls = [];
    // Recording the call order is the point: `acceptAudio` must write the
    // bytes before the row, and the row before the job, so a worker can never
    // dequeue an id whose object is not there yet.
    put = vi.fn(() => {
      calls.push('put');

      return Promise.resolve();
    });
    create = vi.fn(() => {
      calls.push('create');

      return Promise.resolve(row());
    });
    enqueue = vi.fn(() => {
      calls.push('enqueue');

      return Promise.resolve();
    });
    // Stands in for Prisma's returning update: the caller reads the row back,
    // so the stub has to apply the patch rather than echo the original.
    update = vi.fn((args: { data: Record<string, unknown> }) => {
      calls.push('update');

      return Promise.resolve(row(args.data));
    });

    service = new IngestionService(
      { ingestionRecord: { create, update, findFirst: vi.fn(), findMany: vi.fn() } } as never,
      { put } as never,
      { enqueue } as never,
    );
  });

  it('stores the object before the row, and the row before the job', async () => {
    await service.acceptAudio(USER_ID, file);

    // A row pointing at a key that was never written is a broken record; a job
    // pointing at a row that does not exist is an unrecoverable one.
    expect(calls).toEqual(['put', 'create', 'enqueue']);
  });

  it('writes the object under a user-prefixed key with the declared type', async () => {
    await service.acceptAudio(USER_ID, file);

    const [key, body, contentType] = put.mock.calls[0] as [string, Buffer, string];

    expect(key.startsWith(`${USER_ID}/`)).toBe(true);
    expect(key.endsWith('.webm')).toBe(true);
    expect(body).toBe(file.buffer);
    expect(contentType).toBe('audio/webm');
  });

  it('records the row against the same key it just wrote', async () => {
    await service.acceptAudio(USER_ID, file);

    const [{ data }] = create.mock.calls[0] as [{ data: Record<string, unknown> }];
    const [key] = put.mock.calls[0] as [string];

    expect(data).toEqual({ userId: USER_ID, objectKey: key, status: 'uploaded', enqueueCount: 1 });
  });

  it('enqueues the record id, not the payload, as the first run of it', async () => {
    await service.acceptAudio(USER_ID, file);

    expect(enqueue).toHaveBeenCalledWith(RECORD_ID, 1);
  });

  it('still accepts the upload when the queue is unreachable', async () => {
    enqueue.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    // The bytes and the record are already durable, so failing the request
    // would ask the user to re-upload something the server already has.
    const record = await service.acceptAudio(USER_ID, file);

    expect(record.id).toBe(RECORD_ID);
  });

  it('marks the record failed when the job could not be enqueued', async () => {
    enqueue.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    const record = await service.acceptAudio(USER_ID, file);

    // Left on `uploaded` this row is indistinguishable from one whose job is
    // simply waiting its turn, so nothing would ever notice it was dropped.
    expect(update).toHaveBeenCalledWith({
      where: { id: RECORD_ID },
      // Retryable: nothing reached a provider, so trying again costs nothing.
      data: {
        status: 'failed',
        error: 'enqueue failed: connect ECONNREFUSED 127.0.0.1:6379',
        failureKind: 'retryable',
      },
    });
    // And the caller is told the truth in the same breath as the 202.
    expect(record.status).toBe('failed');
    expect(record.error).toBe('enqueue failed: connect ECONNREFUSED 127.0.0.1:6379');
  });

  it('marks it failed only after the enqueue attempt, never before', async () => {
    enqueue.mockRejectedValue(new Error('boom'));

    await service.acceptAudio(USER_ID, file);

    // Read off the shared invocation counter rather than the `calls` array:
    // mockRejectedValue replaces the implementation that would have recorded
    // the enqueue, so the array alone cannot see this ordering.
    const [enqueuedAt] = enqueue.mock.invocationCallOrder;
    const [updatedAt] = update.mock.invocationCallOrder;

    expect(updatedAt).toBeGreaterThan(enqueuedAt as number);
  });

  it('leaves the record alone when the job is enqueued', async () => {
    const record = await service.acceptAudio(USER_ID, file);

    expect(update).not.toHaveBeenCalled();
    expect(record.status).toBe('uploaded');
    expect(record.error).toBeNull();
  });

  it('still accepts the upload when even the failure cannot be recorded', async () => {
    enqueue.mockRejectedValue(new Error('queue down'));
    update.mockRejectedValue(new Error('database down'));

    // Losing the database after the row was written is a bigger problem than
    // this bookkeeping, and the upload itself did succeed — so the caller still
    // gets the id it needs to ask about later.
    const record = await service.acceptAudio(USER_ID, file);

    expect(record.id).toBe(RECORD_ID);
  });

  it('does not write a row when the object could not be stored', async () => {
    put.mockRejectedValue(new Error('NoSuchBucket'));

    await expect(service.acceptAudio(USER_ID, file)).rejects.toThrow('NoSuchBucket');
    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns timestamps as ISO strings, not Date objects', async () => {
    const record = await service.acceptAudio(USER_ID, file);

    expect(record.createdAt).toBe('2026-09-08T10:00:00.000Z');
    expect(record.updatedAt).toBe('2026-09-08T10:00:00.000Z');
  });
});

describe('IngestionService reads', () => {
  it('scopes a lookup by owner in the query rather than checking afterwards', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new IngestionService(
      { ingestionRecord: { findFirst } } as never,
      {} as never,
      {} as never,
    );

    await service.findOne(USER_ID, RECORD_ID);

    // Filtering after the fetch would still answer correctly, but only as long
    // as nobody forgot the check; putting userId in the where clause makes the
    // other user's row unreachable rather than merely rejected.
    expect(findFirst).toHaveBeenCalledWith({ where: { id: RECORD_ID, userId: USER_ID } });
  });

  it("lists only the caller's rows, newest first", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new IngestionService(
      { ingestionRecord: { findMany } } as never,
      {} as never,
      {} as never,
    );

    await service.list(USER_ID);

    // `deletedAt: null` as well as the ownership scope: the list is the user's
    // working view, and a memo they asked to be rid of has no place in it.
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  });
});

/**
 * The ordering guarantee of erasing one: the object goes before the row.
 *
 * Whether the object is actually gone from the bucket is proved against real
 * MinIO in `erasing a memo` (e2e). What is provable here — and only here — is
 * what happens when storage refuses.
 */
describe('IngestionService.remove', () => {
  let calls: string[];
  let remove: ReturnType<typeof vi.fn>;
  let deleteMany: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let service: IngestionService;

  const record = {
    id: RECORD_ID,
    userId: USER_ID,
    objectKey: `${USER_ID}/abc.webm`,
    status: 'draft_created',
    transcript: 'Book the car in',
    error: null,
    deletedAt: null,
    createdAt: new Date('2026-09-08T10:00:00.000Z'),
    updatedAt: new Date('2026-09-08T10:00:00.000Z'),
  };

  beforeEach(() => {
    calls = [];
    remove = vi.fn(() => {
      calls.push('remove');

      return Promise.resolve();
    });
    deleteMany = vi.fn(() => {
      calls.push('deleteMany');

      return Promise.resolve({ count: 2 });
    });
    update = vi.fn(() => {
      calls.push('update');

      return Promise.resolve(record);
    });
    findFirst = vi.fn(() => Promise.resolve(record));

    service = new IngestionService(
      {
        ingestionRecord: { findFirst, update },
        task: { deleteMany },
        // The array form: both writes land or neither does.
        $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      } as never,
      { remove } as never,
      { enqueue: vi.fn() } as never,
    );
  });

  it('erases the object before it touches the row', async () => {
    const result = await service.remove(USER_ID, RECORD_ID);

    // This order is what keeps a failure recoverable. The reverse leaves the
    // file in the bucket with nothing pointing at it — an orphan no code path
    // can reach, which is the thing this route exists to prevent.
    expect(calls).toEqual(['remove', 'deleteMany', 'update']);
    expect(remove).toHaveBeenCalledWith(`${USER_ID}/abc.webm`);
    expect(result).toEqual({ id: RECORD_ID, deletedDrafts: 2 });
  });

  it('aborts with the row untouched when storage refuses', async () => {
    remove.mockRejectedValue(new Error('bucket unreachable'));

    await expect(service.remove(USER_ID, RECORD_ID)).rejects.toThrow('bucket unreachable');

    // Nothing was marked deleted, so the user can retry and the record still
    // says what it is. DeleteObject succeeding on a missing key is what makes
    // that retry safe.
    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('deletes only the drafts nobody confirmed', async () => {
    await service.remove(USER_ID, RECORD_ID);

    // Both halves of `isTaskDraft`, plus the ownership scope. Dropping
    // `confirmedAt` here would sweep away tasks the user adopted as their own.
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        ingestionRecordId: RECORD_ID,
        userId: USER_ID,
        source: 'ai_suggested',
        confirmedAt: null,
      },
    });
  });

  it('clears the transcript but keeps the account of what happened', async () => {
    await service.remove(USER_ID, RECORD_ID);

    const [args] = update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(args.data.transcript).toBeNull();
    expect(args.data.deletedAt).toBeInstanceOf(Date);
    // `status` and `error` are not in the patch at all: they are the only
    // remaining record of an object that no longer exists.
    expect(args.data).not.toHaveProperty('status');
    expect(args.data).not.toHaveProperty('error');
  });

  it('keeps the first deletion timestamp on a second call', async () => {
    const alreadyGone = new Date('2026-09-08T11:00:00.000Z');
    findFirst.mockResolvedValue({ ...record, deletedAt: alreadyGone, transcript: null });

    await service.remove(USER_ID, RECORD_ID);

    const [args] = update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(args.data.deletedAt).toBe(alreadyGone);
  });

  it('404s without erasing anything when the record is not the caller\u2019s', async () => {
    findFirst.mockResolvedValue(null);

    await expect(service.remove(USER_ID, RECORD_ID)).rejects.toBeInstanceOf(NotFoundException);

    // The scoped read is the guard, and nothing runs behind it.
    expect(findFirst).toHaveBeenCalledWith({ where: { id: RECORD_ID, userId: USER_ID } });
    expect(remove).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * The manual retry's own decisions. That it really re-runs the pipeline, and
 * that BullMQ really accepts the new job, is proved against Redis and
 * Postgres in `retrying a failed memo` (e2e) — a mocked queue would agree
 * with any job id.
 */
describe('IngestionService.retry', () => {
  let findFirst: ReturnType<typeof vi.fn>;
  let updateMany: ReturnType<typeof vi.fn>;
  let findUniqueOrThrow: ReturnType<typeof vi.fn>;
  let enqueue: ReturnType<typeof vi.fn>;
  let service: IngestionService;

  const failed = {
    id: RECORD_ID,
    userId: USER_ID,
    objectKey: `${USER_ID}/abc.webm`,
    status: 'failed',
    transcript: null,
    error: 'Whisper returned 400: Invalid file format',
    failureKind: 'permanent',
    autoRetries: 0,
    enqueueCount: 1,
    deletedAt: null,
    createdAt: new Date('2026-09-08T10:00:00.000Z'),
    updatedAt: new Date('2026-09-08T10:00:00.000Z'),
  };

  beforeEach(() => {
    findFirst = vi.fn(() => Promise.resolve(failed));
    updateMany = vi.fn(() => Promise.resolve({ count: 1 }));
    findUniqueOrThrow = vi.fn(() =>
      Promise.resolve({ ...failed, status: 'uploaded', error: null, failureKind: null, enqueueCount: 2 }),
    );
    enqueue = vi.fn(() => Promise.resolve());

    service = new IngestionService(
      { ingestionRecord: { findFirst, updateMany, findUniqueOrThrow, update: vi.fn() } } as never,
      {} as never,
      { enqueue } as never,
    );
  });

  it('claims the memo only from failed, and starts a fresh run with a fresh job id', async () => {
    const record = await service.retry(USER_ID, RECORD_ID);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: RECORD_ID, userId: USER_ID, status: 'failed', deletedAt: null },
      data: {
        status: 'uploaded',
        error: null,
        failureKind: null,
        autoRetries: 0,
        enqueueCount: { increment: 1 },
      },
    });
    expect(enqueue).toHaveBeenCalledWith(RECORD_ID, 2);
    expect(record.status).toBe('uploaded');
  });

  it('retries a permanent failure too, because the person pressing it has decided', async () => {
    await service.retry(USER_ID, RECORD_ID);

    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('404s without touching anything when the memo is not the caller’s', async () => {
    findFirst.mockResolvedValue(null);

    await expect(service.retry(USER_ID, RECORD_ID)).rejects.toThrow('not found');
    expect(updateMany).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('409s on an erased memo, because there is nothing left to run', async () => {
    findFirst.mockResolvedValue({ ...failed, deletedAt: new Date() });

    await expect(service.retry(USER_ID, RECORD_ID)).rejects.toThrow('erased');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('409s when the claim matched nothing — not failed, or another tap got there first', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(service.retry(USER_ID, RECORD_ID)).rejects.toThrow('Only a failed memo');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
