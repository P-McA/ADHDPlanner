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
    error: null,
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

    expect(data).toEqual({ userId: USER_ID, objectKey: key, status: 'uploaded' });
  });

  it('enqueues the record id, not the payload', async () => {
    await service.acceptAudio(USER_ID, file);

    expect(enqueue).toHaveBeenCalledWith(RECORD_ID);
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
      data: { status: 'failed', error: 'enqueue failed: connect ECONNREFUSED 127.0.0.1:6379' },
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

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { createdAt: 'desc' },
    });
  });
});
