import { DECOMPOSITION_TIMEOUT_MS, MAX_STEPS } from '@adhd/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DECOMPOSITION_MODEL, DECOMPOSITION_SEED, OpenAiDecomposer } from './openai.decomposer.js';
import { ProviderError } from './provider-error.js';

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

function stepsJson(steps: unknown[]) {
  return JSON.stringify({ steps });
}

const TASK = { title: 'Book the car in for its MOT', description: null };

describe('OpenAiDecomposer', () => {
  let decomposer: OpenAiDecomposer;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    decomposer = new OpenAiDecomposer();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it('returns the steps the model proposed, in its order', async () => {
    globalThis.fetch = completion(
      stepsJson([{ title: 'Find the reminder letter' }, { title: 'Ring the garage' }]),
    );

    await expect(decomposer.decompose(TASK)).resolves.toEqual([
      { title: 'Find the reminder letter' },
      { title: 'Ring the garage' },
    ]);
  });

  it('asks for strict, pinned, seeded output with the documented deadline', async () => {
    const fetchMock = completion(stepsJson([]));
    globalThis.fetch = fetchMock;

    await decomposer.decompose(TASK);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      model: string;
      temperature: number;
      seed: number;
      response_format: { type: string; json_schema: { strict: boolean; schema: { required: string[] } } };
      messages: { role: string; content: string }[];
    };

    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body.model).toMatch(/^gpt-4o-\d{4}-\d{2}-\d{2}$/);
    expect(body.model).toBe(DECOMPOSITION_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(DECOMPOSITION_SEED);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.required).toEqual(['steps']);
    // The task the user pressed the button on is what the model is told about.
    expect(body.messages.at(-1)?.content).toContain('Book the car in for its MOT');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(DECOMPOSITION_TIMEOUT_MS).toBe(30_000);
  });

  it('drops unusable rows and a step that only restates the task', async () => {
    globalThis.fetch = completion(
      stepsJson([{ title: '' }, { title: 'Book the car in for its MOT' }, { title: 'Ring the garage' }]),
    );

    await expect(decomposer.decompose(TASK)).resolves.toEqual([{ title: 'Ring the garage' }]);
  });

  it(`stops at ${String(MAX_STEPS)} steps however many come back`, async () => {
    globalThis.fetch = completion(
      stepsJson(Array.from({ length: 11 }, (_, i) => ({ title: `Step ${String(i)}` }))),
    );

    await expect(decomposer.decompose(TASK)).resolves.toHaveLength(MAX_STEPS);
  });

  it('classifies a rate limit as retryable and a bad request as permanent', async () => {
    for (const [status, kind] of [
      [429, 'retryable'],
      [400, 'permanent'],
    ] as const) {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status,
          text: () => Promise.resolve('nope'),
        } as unknown as Response),
      );

      const error = await decomposer.decompose(TASK).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe(kind);
      expect((error as ProviderError).message).toContain(`Decomposition returned ${String(status)}`);
    }
  });

  it('says the model refused, rather than that it returned nothing', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: null, refusal: 'No.' } }] }),
        text: () => Promise.resolve(''),
      } as unknown as Response),
    );

    await expect(decomposer.decompose(TASK)).rejects.toThrow('Decomposition was refused: No.');
  });

  it('refuses to call the provider at all with no key, and says what to do', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await expect(decomposer.decompose(TASK)).rejects.toThrow('OPENAI_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
