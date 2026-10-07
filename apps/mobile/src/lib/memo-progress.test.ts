import type { IngestionRecord, IngestionStatus } from '@adhd/shared';

import { describeOutcome, followMemo } from './memo-progress';

/**
 * The missing step behind "Queued, then nothing": waiting for the worker and
 * saying what it found. Clock, sleep and API are injected, so these run
 * instantly and the sequence of polls is exact.
 */

const record = (status: IngestionStatus, over: Partial<IngestionRecord> = {}): IngestionRecord =>
  ({
    id: 'r1',
    status,
    transcript: null,
    error: null,
    createdAt: '2026-10-07T18:13:08Z',
    updatedAt: '2026-10-07T18:13:08Z',
    deletedAt: null,
    ...over,
  }) as IngestionRecord;

function fakeClock() {
  let t = 0;

  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;

      return Promise.resolve();
    },
  };
}

describe('followMemo', () => {
  it('keeps asking until the memo is done, then reports what it heard and found', async () => {
    const statuses: IngestionRecord[] = [
      record('uploaded'),
      record('transcribing'),
      record('extracting', { transcript: 'Go to the shop and get some food.' }),
      record('draft_created', { transcript: 'Go to the shop and get some food.' }),
    ];
    const get = jest.fn(() => Promise.resolve(statuses.shift() ?? record('failed')));
    const countDrafts = jest.fn(() => Promise.resolve(1));

    const message = await followMemo('r1', { get, countDrafts, ...fakeClock() });

    expect(get).toHaveBeenCalledTimes(4);
    expect(countDrafts).toHaveBeenCalledWith('r1');
    expect(message).toBe(
      'Heard “Go to the shop and get some food.” — 1 suggestion added below. Approve to make it a task.',
    );
  });

  it('says so when a note held nothing to do, instead of staying silent', async () => {
    const message = await followMemo('r1', {
      get: () => Promise.resolve(record('draft_created', { transcript: 'you' })),
      countDrafts: () => Promise.resolve(0),
      ...fakeClock(),
    });

    expect(message).toBe('Heard “you” — nothing in it to suggest as a task.');
  });

  it('passes the failure reason through rather than hiding it', async () => {
    const countDrafts = jest.fn();
    const message = await followMemo('r1', {
      get: () =>
        Promise.resolve(record('failed', { error: 'Whisper returned 400: Invalid file format' })),
      countDrafts,
      ...fakeClock(),
    });

    expect(message).toBe("Couldn't process that note: Whisper returned 400: Invalid file format");
    expect(countDrafts).not.toHaveBeenCalled();
  });

  it('gives up after its deadline with a message, not an endless spinner', async () => {
    const get = jest.fn(() => Promise.resolve(record('transcribing')));

    const message = await followMemo('r1', {
      get,
      countDrafts: jest.fn(),
      intervalMs: 1000,
      timeoutMs: 5000,
      ...fakeClock(),
    });

    expect(message).toMatch(/^Still working on that note/);
    expect(get).toHaveBeenCalledTimes(6);
  });
});

describe('describeOutcome', () => {
  it('pluralises several suggestions', () => {
    expect(describeOutcome(record('draft_created', { transcript: 'a and b' }), 2)).toBe(
      'Heard “a and b” — 2 suggestions added below. Approve to make them tasks.',
    );
  });

  it('says "nothing" for an empty transcript', () => {
    expect(describeOutcome(record('draft_created', { transcript: '  ' }), 0)).toBe(
      'Heard nothing — nothing in it to suggest as a task.',
    );
  });
});
