import type { DraftCandidate } from '@adhd/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Extractor, Transcriber } from '../ai/ai.ports.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StorageService } from '../storage/storage.service.js';
import { AudioIngestionProcessor } from './audio-ingestion.processor.js';

const RECORD_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

type Row = {
  id: string;
  userId: string;
  objectKey: string;
  status: string;
  transcript: string | null;
  error: string | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: RECORD_ID,
    userId: USER_ID,
    objectKey: `${USER_ID}/memo.webm`,
    status: 'uploaded',
    transcript: null,
    error: null,
    ...overrides,
  };
}

describe('AudioIngestionProcessor', () => {
  let current: Row;
  let findUnique: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let createTask: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let transcribe: ReturnType<typeof vi.fn>;
  let extract: ReturnType<typeof vi.fn>;
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
    // Applies the patch, so a later read in the same run sees the new state.
    update = vi.fn((args: { data: Partial<Row> }) => {
      current = { ...current, ...args.data };

      return Promise.resolve(current);
    });
    createTask = vi.fn((args: { data: unknown }) => Promise.resolve(args.data));
    get = vi.fn(() => Promise.resolve({ body: Buffer.from('audio'), contentType: 'audio/webm' }));
    transcribe = vi.fn(() => Promise.resolve('I need to book the car in.'));
    extract = vi.fn(() =>
      Promise.resolve<DraftCandidate[]>([
        { title: 'Book the car in', dueAt: null, manualPriority: null },
      ]),
    );

    const prisma = {
      ingestionRecord: { findUnique, update },
      task: { create: createTask },
      // The real one is atomic; here it only has to await what it was handed
      // so the operations inside it are observable on the mocks.
      $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
    } as unknown as PrismaService;

    processor = new AudioIngestionProcessor(
      prisma,
      { get } as unknown as StorageService,
      { transcribe } as unknown as Transcriber,
      { extract } as unknown as Extractor,
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

  it('drops a job whose record is gone instead of spinning on it', async () => {
    findUnique.mockResolvedValue(null);

    await expect(processor.process(RECORD_ID)).resolves.toBeUndefined();

    expect(transcribe).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
