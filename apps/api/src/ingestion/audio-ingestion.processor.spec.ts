import type { DraftCandidate } from '@adhd/shared';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { Extractor, Transcriber } from '../ai/ai.ports.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StorageService } from '../storage/storage.service.js';
import { ProviderError } from '../ai/provider-error.js';
import { AudioIngestionProcessor } from './audio-ingestion.processor.js';
import type { AudioIngestionQueue } from './audio-ingestion.queue.js';

const RECORD_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

type Row = {
  id: string;
  userId: string;
  objectKey: string;
  status: string;
  transcript: string | null;
  error: string | null;
  failureKind: string | null;
  autoRetries: number;
  enqueueCount: number;
  deletedAt: Date | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: RECORD_ID,
    userId: USER_ID,
    objectKey: `${USER_ID}/memo.webm`,
    status: 'uploaded',
    transcript: null,
    error: null,
    failureKind: null,
    autoRetries: 0,
    enqueueCount: 1,
    deletedAt: null,
    ...overrides,
  };
}

describe('AudioIngestionProcessor', () => {
  let current: Row;
  let findUnique: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let createTask: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let transcribe: Mock<Transcriber['transcribe']>;
  let extract: Mock<Extractor['extract']>;
  let enqueue: Mock<AudioIngestionQueue['enqueue']>;
  let processor: AudioIngestionProcessor;

  /** Every status the record passed through, in order. */
  function transitions(): string[] {
    return update.mock.calls
      .map(([args]) => (args as { data: { status?: string } }).data.status)
      .filter((status): status is string => status !== undefined);
  }

  beforeEach(() => {
    current = row();

    findUnique = vi.fn(() => Promise.resolve(current));
    // A conditional updateMany, as the processor issues it: the patch lands
    // only if the row still matches the WHERE clause, so a later read in the
    // same run sees the new state and a closed row is left alone.
    update = vi.fn(
      (args: { where: { deletedAt?: null; status?: { notIn: string[] } }; data: Partial<Row> }) => {
        const open =
          (args.where.deletedAt !== null || current.deletedAt === null) &&
          !(args.where.status?.notIn.includes(current.status) ?? false);
        if (!open) return Promise.resolve({ count: 0 });

        // Prisma's `{ increment: n }`, applied the way the database would.
        const patch = Object.fromEntries(
          Object.entries(args.data).map(([key, value]) => [
            key,
            typeof value === 'object' && value !== null && 'increment' in value
              ? (current[key as keyof Row] as number) + (value as { increment: number }).increment
              : value,
          ]),
        ) as Partial<Row>;
        current = { ...current, ...patch };

        return Promise.resolve({ count: 1 });
      },
    );
    createTask = vi.fn((args: { data: unknown }) => Promise.resolve(args.data));
    enqueue = vi.fn<AudioIngestionQueue['enqueue']>(() => Promise.resolve());
    get = vi.fn(() => Promise.resolve({ body: Buffer.from('audio'), contentType: 'audio/webm' }));
    transcribe = vi.fn<Transcriber['transcribe']>(() =>
      Promise.resolve('I need to book the car in.'),
    );
    extract = vi.fn<Extractor['extract']>(() =>
      Promise.resolve<DraftCandidate[]>([
        { title: 'Book the car in', dueAt: null, manualPriority: null },
      ]),
    );

    const client = {
      ingestionRecord: { findUnique, updateMany: update },
      task: { create: createTask },
    };
    const prisma = {
      ...client,
      // The real one is atomic; here it only has to run the callback against
      // the same mocks so the operations inside it are observable. Atomicity
      // and the row lock are proved against Postgres in the e2e suite.
      $transaction: (fn: (tx: typeof client) => Promise<unknown>) => fn(client),
    } as unknown as PrismaService;

    processor = new AudioIngestionProcessor(
      prisma,
      { get } as unknown as StorageService,
      { transcribe },
      { extract },
      { enqueue } as unknown as AudioIngestionQueue,
    );
  });

  it('walks the record through every stage, writing each one down', async () => {
    await processor.process(RECORD_ID);

    // Each stage is a database write, so a worker that dies leaves the record
    // parked on the stage it died in rather than vanishing.
    expect(transitions()).toEqual(['transcribing', 'extracting', 'draft_created']);
  });

  it('stores the transcript before extraction runs', async () => {
    await processor.process(RECORD_ID);

    const stored = update.mock.calls.find(
      ([args]) => (args as { data: { transcript?: string } }).data.transcript !== undefined,
    );

    expect(stored).toBeDefined();
    expect((stored?.[0] as { data: { transcript: string } }).data.transcript).toBe(
      'I need to book the car in.',
    );
    // Stored, then extracted from — not the other way round, so a memo whose
    // extraction fails still shows the user what was heard.
    expect(update.mock.invocationCallOrder[1] as number).toBeLessThan(
      extract.mock.invocationCallOrder[0] as number,
    );
  });

  it('keeps the transcript even when the memo held no task at all', async () => {
    extract.mockResolvedValue([]);

    await processor.process(RECORD_ID);

    expect(current.transcript).toBe('I need to book the car in.');
    expect(current.status).toBe('draft_created');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('creates drafts, never live tasks', async () => {
    extract.mockResolvedValue([
      { title: 'Book the car in', dueAt: '2026-09-11T09:00:00.000Z', manualPriority: 'high' },
    ]);

    await processor.process(RECORD_ID);

    const data = createTask.mock.calls[0]?.[0] as { data: Record<string, unknown> };

    // The human-in-the-loop fence, as data. Nothing here can produce a
    // confirmed task, whatever the model returns.
    expect(data.data.source).toBe('ai_suggested');
    expect(data.data.confirmedAt).toBeNull();
    expect(data.data.userId).toBe(USER_ID);
    expect(data.data.ingestionRecordId).toBe(RECORD_ID);
    expect(data.data.title).toBe('Book the car in');
    expect(data.data.dueAt).toEqual(new Date('2026-09-11T09:00:00.000Z'));
    expect(data.data.manualPriority).toBe('high');
  });

  it('leaves priority to the column default when the speaker did not signal one', async () => {
    await processor.process(RECORD_ID);

    const data = createTask.mock.calls[0]?.[0] as { data: Record<string, unknown> };

    expect(data.data).not.toHaveProperty('manualPriority');
  });

  it('records a transcription failure on the row and does not throw', async () => {
    transcribe.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    // Not throwing is the point: a rejection here would hand the job back to
    // BullMQ's retry policy, and a hung provider call must end as an
    // inspectable record rather than three more hung provider calls.
    await expect(processor.process(RECORD_ID)).resolves.toBeUndefined();

    expect(current.status).toBe('failed');
    expect(current.error).toBe('The operation was aborted due to timeout');
    expect(extract).not.toHaveBeenCalled();
  });

  it('records an extraction failure on the row, keeping the transcript', async () => {
    extract.mockRejectedValue(new Error('Extraction returned 429: Rate limit reached'));

    await processor.process(RECORD_ID);

    expect(current.status).toBe('failed');
    expect(current.error).toBe('Extraction returned 429: Rate limit reached');
    expect(current.transcript).toBe('I need to book the car in.');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('records a storage failure without ever calling a provider', async () => {
    get.mockRejectedValue(new Error('NoSuchKey: the specified key does not exist'));

    await processor.process(RECORD_ID);

    expect(current.status).toBe('failed');
    expect(current.error).toContain('NoSuchKey');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('does nothing for a record that already produced drafts', async () => {
    current = row({ status: 'draft_created', transcript: 'done already' });

    await processor.process(RECORD_ID);

    // A duplicate delivery must not double the user's drafts.
    expect(transcribe).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not silently re-run a record that already failed', async () => {
    current = row({ status: 'failed', error: 'boom' });

    await processor.process(RECORD_ID);

    expect(transcribe).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('resumes at extraction rather than paying for a second transcription', async () => {
    current = row({ status: 'transcribing', transcript: 'I need to book the car in.' });

    await processor.process(RECORD_ID);

    expect(transcribe).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledWith('I need to book the car in.');
    expect(transitions()).toEqual(['extracting', 'draft_created']);
  });

  it('does not run a memo the user erased while its job was waiting', async () => {
    current = row({ deletedAt: new Date('2026-10-07T10:00:00Z') });

    await expect(processor.process(RECORD_ID)).resolves.toBeUndefined();

    expect(get).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('guards every write on the record still being open', async () => {
    await processor.process(RECORD_ID);

    // The up-front read is a snapshot; only the WHERE clause on each write is
    // checked at the moment it lands.
    for (const [args] of update.mock.calls) {
      expect((args as { where: unknown }).where).toEqual({
        id: RECORD_ID,
        deletedAt: null,
        status: { notIn: ['draft_created', 'failed'] },
      });
    }
  });

  it('writes nothing back when the memo is erased during transcription', async () => {
    transcribe.mockImplementation(() => {
      current = { ...current, deletedAt: new Date(), transcript: null };

      return Promise.resolve('I need to book the car in.');
    });

    await expect(processor.process(RECORD_ID)).resolves.toBeUndefined();

    expect(current.transcript).toBeNull();
    expect(current.status).toBe('transcribing');
    expect(current.error).toBeNull();
    expect(extract).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('creates no drafts when another delivery settled the record first', async () => {
    // The overlapping copy finished while this one was extracting.
    extract.mockImplementation(() => {
      current = { ...current, status: 'draft_created' };

      return Promise.resolve([{ title: 'Book the car in', dueAt: null, manualPriority: null }]);
    });

    await processor.process(RECORD_ID);

    expect(createTask).not.toHaveBeenCalled();
    expect(current.status).toBe('draft_created');
    expect(current.error).toBeNull();
  });

  it("does not let a losing copy's failure overwrite the winner's result", async () => {
    extract.mockImplementation(() => {
      current = { ...current, status: 'draft_created' };

      return Promise.reject(new Error('Extraction returned 429: Rate limit reached'));
    });

    await processor.process(RECORD_ID);

    expect(current.status).toBe('draft_created');
    expect(current.error).toBeNull();
  });

  describe('automatic retry', () => {
    it('schedules a retry for a rate limit instead of failing, keeping the reason', async () => {
      transcribe.mockRejectedValue(
        new ProviderError('Whisper returned 429: Rate limit reached', 'retryable'),
      );

      await expect(processor.process(RECORD_ID)).resolves.toBeUndefined();

      expect(current.status).toBe('uploaded');
      expect(current.error).toBe('Whisper returned 429: Rate limit reached');
      expect(current.failureKind).toBeNull();
      expect(current.autoRetries).toBe(1);
      // A job id BullMQ has never held, and a delay before it runs.
      expect(current.enqueueCount).toBe(2);
      expect(enqueue).toHaveBeenCalledWith(RECORD_ID, 2, 5_000);
    });

    it('treats a provider deadline as retryable', async () => {
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      transcribe.mockRejectedValue(timeout);

      await processor.process(RECORD_ID);

      expect(current.status).toBe('uploaded');
      expect(enqueue).toHaveBeenCalledOnce();
    });

    it('never retries a permanent failure on its own, and says which kind it was', async () => {
      transcribe.mockRejectedValue(
        new ProviderError('Whisper returned 400: Invalid file format', 'permanent'),
      );

      await processor.process(RECORD_ID);

      expect(current.status).toBe('failed');
      expect(current.failureKind).toBe('permanent');
      expect(current.autoRetries).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('calls a failure it cannot classify permanent, rather than paying to guess', async () => {
      get.mockRejectedValue(new Error('NoSuchKey: the specified key does not exist'));

      await processor.process(RECORD_ID);

      expect(current.failureKind).toBe('permanent');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('gives up after the allowance and parks the memo on failed for a human', async () => {
      current = row({ autoRetries: 3, enqueueCount: 4 });
      extract.mockRejectedValue(
        new ProviderError('Extraction returned 503: Service Unavailable', 'retryable'),
      );

      await processor.process(RECORD_ID);

      expect(current.status).toBe('failed');
      expect(current.failureKind).toBe('retryable');
      expect(current.autoRetries).toBe(3);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('waits longer before each later retry', async () => {
      current = row({ autoRetries: 2, enqueueCount: 3 });
      extract.mockRejectedValue(new ProviderError('Extraction returned 429', 'retryable'));

      await processor.process(RECORD_ID);

      expect(enqueue).toHaveBeenCalledWith(RECORD_ID, 4, 60_000);
    });

    it('keeps the transcript, so the retry resumes at extraction', async () => {
      extract.mockRejectedValue(new ProviderError('Extraction returned 429', 'retryable'));

      await processor.process(RECORD_ID);

      expect(current.transcript).toBe('I need to book the car in.');
      expect(current.status).toBe('uploaded');
    });

    it('schedules nothing for a memo erased during the failing call', async () => {
      transcribe.mockImplementation(() => {
        current = { ...current, deletedAt: new Date() };

        return Promise.reject(new ProviderError('Whisper returned 429', 'retryable'));
      });

      await processor.process(RECORD_ID);

      expect(enqueue).not.toHaveBeenCalled();
      expect(current.status).toBe('transcribing');
    });

    it('parks the memo on failed when the retry cannot be queued', async () => {
      transcribe.mockRejectedValue(new ProviderError('Whisper returned 429', 'retryable'));
      enqueue.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

      await expect(processor.process(RECORD_ID)).resolves.toBeUndefined();

      // Never left on `uploaded` with nothing coming for it.
      expect(current.status).toBe('failed');
      expect(current.failureKind).toBe('retryable');
      expect(current.error).toContain('retry not queued');
    });
  });

  it('drops a job whose record is gone instead of spinning on it', async () => {
    findUnique.mockResolvedValue(null);

    await expect(processor.process(RECORD_ID)).resolves.toBeUndefined();

    expect(transcribe).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
