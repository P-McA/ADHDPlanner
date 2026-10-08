import { EXTRACTION_TIMEOUT_MS } from '@adhd/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXTRACTION_MODEL, EXTRACTION_SEED, OpenAiExtractor } from './openai.extractor.js';

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
      model: string;
      temperature: number;
      seed: number;
      response_format: { type: string; json_schema: { strict: boolean; schema: unknown } };
      messages: { role: string; content: string }[];
    };

    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    // The same memo must produce the same drafts; this is extraction, not
    // authorship, so sampling variety would be a bug.
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(EXTRACTION_SEED);
    // A dated snapshot, so a model change is a diff, never a surprise.
    expect(body.model).toMatch(/^gpt-4o-\d{4}-\d{2}-\d{2}$/);
    expect(body.model).toBe(EXTRACTION_MODEL);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(EXTRACTION_TIMEOUT_MS).toBe(30_000);
  });

  it('sends the shared contract as the schema, in the form strict mode accepts', async () => {
    const fetchMock = completion(tasksJson([]));
    globalThis.fetch = fetchMock;

    await extractor.extract('...');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const { response_format: format } = JSON.parse(init.body as string) as {
      response_format: { json_schema: { schema: Record<string, unknown> } };
    };
    const schema = format.json_schema.schema as {
      additionalProperties: boolean;
      required: string[];
      properties: { tasks: { items: { additionalProperties: boolean; required: string[] } } };
    };

    // Strict mode rejects a schema with an optional property or open object,
    // and the provider says so only at call time — so it is pinned here.
    expect(schema).not.toHaveProperty('$schema');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['tasks']);
    expect(schema.properties.tasks.items.additionalProperties).toBe(false);
    expect(schema.properties.tasks.items.required).toEqual(['title', 'dueAt', 'manualPriority']);
  });

  it('says the model refused, rather than that it returned nothing', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ choices: [{ message: { content: null, refusal: "I can't help" } }] }),
        text: () => Promise.resolve(''),
      } as unknown as Response),
    );

    await expect(extractor.extract('...')).rejects.toThrow("Extraction was refused: I can't help");
  });

  it('nulls a date-only due date, because the contract asks for a full timestamp', async () => {
    globalThis.fetch = completion(
      tasksJson([{ title: 'Call the dentist', dueAt: '2026-09-11', manualPriority: null }]),
    );

    // "2026-09-11" has no time and no offset: midnight where? The user's day
    // boundary is not UTC's, so guessing would put it on the wrong day.
    await expect(extractor.extract('...')).resolves.toEqual([
      { title: 'Call the dentist', dueAt: null, manualPriority: null },
    ]);
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
