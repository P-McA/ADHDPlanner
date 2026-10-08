import { ESTIMATE_BUCKETS, ESTIMATION_TIMEOUT_MS } from '@adhd/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ESTIMATION_MODEL, ESTIMATION_SEED, OpenAiEstimator } from './openai.estimator.js';
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

const TASK = { title: 'Book the car in for its MOT', description: null };

describe('OpenAiEstimator', () => {
  let estimator: OpenAiEstimator;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    estimator = new OpenAiEstimator();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it('returns the bucket the model chose', async () => {
    globalThis.fetch = completion(JSON.stringify({ minutes: 30 }));

    await expect(estimator.estimate(TASK)).resolves.toBe(30);
  });

  it('asks for strict, pinned, seeded output limited to the buckets, with the documented deadline', async () => {
    const fetchMock = completion(JSON.stringify({ minutes: 15 }));
    globalThis.fetch = fetchMock;

    await estimator.estimate(TASK);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      model: string;
      temperature: number;
      seed: number;
      response_format: {
        type: string;
        json_schema: { strict: boolean; schema: { properties: { minutes: { enum: number[] } } } };
      };
      messages: { role: string; content: string }[];
    };

    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(body.model).toMatch(/^gpt-4o-\d{4}-\d{2}-\d{2}$/);
    expect(body.model).toBe(ESTIMATION_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(ESTIMATION_SEED);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.properties.minutes.enum).toEqual([
      ...ESTIMATE_BUCKETS,
    ]);
    expect(body.messages.at(-1)?.content).toContain('Book the car in for its MOT');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(ESTIMATION_TIMEOUT_MS).toBe(30_000);
  });

  it('refuses an answer that is not a bucket, rather than rounding it into one', async () => {
    // Strict mode should make this impossible. If it ever happens, storing a
    // snapped guess would be worse than saying the model gave no usable answer.
    globalThis.fetch = completion(JSON.stringify({ minutes: 37 }));

    const error = await estimator.estimate(TASK).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('permanent');
    expect((error as ProviderError).message).toContain('no usable estimate');
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

      const error = await estimator.estimate(TASK).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe(kind);
      expect((error as ProviderError).message).toContain(`Estimation returned ${String(status)}`);
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

    await expect(estimator.estimate(TASK)).rejects.toThrow('Estimation was refused: No.');
  });

  it('refuses to call the provider at all with no key, and says what to do', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await expect(estimator.estimate(TASK)).rejects.toThrow('OPENAI_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
