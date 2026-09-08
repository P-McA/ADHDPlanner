import { EXTRACTION_TIMEOUT_MS } from '@adhd/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAiExtractor } from './openai.extractor.js';

const realFetch = globalThis.fetch;

/** Wraps `content` the way the chat-completions API does. */
function completion(content: string) {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content } }] }),
      text: () => Promise.resolve(''),
    } as unknown as Response),
  );
}

function tasksJson(tasks: unknown[]) {
  return JSON.stringify({ tasks });
}

describe('OpenAiExtractor', () => {
  let extractor: OpenAiExtractor;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    extractor = new OpenAiExtractor();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it('returns the candidates the model found', async () => {
    globalThis.fetch = completion(
      tasksJson([
        { title: 'Book the car in', dueAt: '2026-09-11T09:00:00.000Z', manualPriority: 'high' },
        { title: 'Call the dentist', dueAt: null, manualPriority: null },
      ]),
    );

    await expect(extractor.extract('...')).resolves.toEqual([
      { title: 'Book the car in', dueAt: '2026-09-11T09:00:00.000Z', manualPriority: 'high' },
      { title: 'Call the dentist', dueAt: null, manualPriority: null },
    ]);
  });

  it('asks for deterministic JSON and attaches the documented deadline', async () => {
    const fetchMock = completion(tasksJson([]));
    globalThis.fetch = fetchMock;

    await extractor.extract('nothing to do here');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      temperature: number;
      response_format: { type: string };
      messages: { role: string; content: string }[];
    };

    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    // The same memo must produce the same drafts; this is extraction, not
    // authorship, so sampling variety would be a bug.
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe('json_object');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(EXTRACTION_TIMEOUT_MS).toBe(30_000);
  });

  it('tells the model what time it is, so "tomorrow" means something', async () => {
    const fetchMock = completion(tasksJson([]));
    globalThis.fetch = fetchMock;

    await extractor.extract('remind me tomorrow');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
    const user = body.messages[1]?.content ?? '';

    expect(user).toContain('Reference time');
    expect(user).toContain('remind me tomorrow');
  });

  it('returns nothing for a memo with nothing in it, rather than reaching', async () => {
    globalThis.fetch = completion(tasksJson([]));

    await expect(extractor.extract('just thinking out loud')).resolves.toEqual([]);
  });

  it('drops a row with no usable title instead of guessing one', async () => {
    globalThis.fetch = completion(
      tasksJson([{ title: '   ', dueAt: null }, { title: 'Call the dentist' }, 'not an object']),
    );

    await expect(extractor.extract('...')).resolves.toEqual([
      { title: 'Call the dentist', dueAt: null, manualPriority: null },
    ]);
  });

  it('nulls a due date or priority it cannot trust rather than storing nonsense', async () => {
    globalThis.fetch = completion(
      tasksJson([{ title: 'Call the dentist', dueAt: 'next tuesday-ish', manualPriority: 'ASAP' }]),
    );

    // A draft whose fields were invented looks more considered than it is, and
    // the user is the one who pays for that in review time.
    await expect(extractor.extract('...')).resolves.toEqual([
      { title: 'Call the dentist', dueAt: null, manualPriority: null },
    ]);
  });

  it('throws on output that is not JSON at all', async () => {
    globalThis.fetch = completion('I found two tasks!');

    await expect(extractor.extract('...')).rejects.toThrow('not JSON');
  });

  it('throws when the JSON has no tasks array', async () => {
    globalThis.fetch = completion('{"result": "ok"}');

    await expect(extractor.extract('...')).rejects.toThrow('no tasks array');
  });

  it('throws with the provider status and body when the call is rejected', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limit reached'),
        json: () => Promise.resolve({}),
      } as unknown as Response),
    );

    await expect(extractor.extract('...')).rejects.toThrow(
      'Extraction returned 429: Rate limit reached',
    );
  });

  it('refuses to call the provider at all with no key', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = completion(tasksJson([]));
    globalThis.fetch = fetchMock;

    await expect(extractor.extract('...')).rejects.toThrow('OPENAI_API_KEY is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
