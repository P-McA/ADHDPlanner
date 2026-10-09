import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_TIMEOUT_MS,
  OpenAiEmbedder,
} from './openai.embedder.js';
import { ProviderError } from './provider-error.js';

const realFetch = globalThis.fetch;

const vector = (fill: number): number[] => Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);

/** The embeddings API's answer, rows deliberately out of order to prove `index` is used. */
function embeddings(rows: { index: number; embedding: number[] }[]) {
  return vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: rows }),
      text: () => Promise.resolve(''),
    } as unknown as Response),
  );
}

describe('OpenAiEmbedder', () => {
  let embedder: OpenAiEmbedder;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    embedder = new OpenAiEmbedder();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it('returns one vector per text, in the order the texts were given', async () => {
    globalThis.fetch = embeddings([
      { index: 1, embedding: vector(0.2) },
      { index: 0, embedding: vector(0.1) },
    ]);

    const result = await embedder.embed(['Book the MOT', 'Pay for the MOT']);

    expect(result.map((row) => row[0])).toEqual([0.1, 0.2]);
  });

  it('asks the embeddings endpoint for the named model, in one batch, with a deadline', async () => {
    const fetchMock = embeddings([{ index: 0, embedding: vector(0) }]);
    globalThis.fetch = fetchMock;

    await embedder.embed(['Book the MOT']);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string; input: string[] };

    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(body).toEqual({ model: EMBEDDING_MODEL, input: ['Book the MOT'] });
    expect(EMBEDDING_MODEL).toBe('text-embedding-3-small');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(EMBEDDING_TIMEOUT_MS).toBe(30_000);
  });

  it('asks nothing at all for nothing', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await expect(embedder.embed([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an answer with the wrong number of vectors or the wrong size', async () => {
    globalThis.fetch = embeddings([{ index: 0, embedding: vector(0) }]);
    await expect(embedder.embed(['a', 'b'])).rejects.toThrow('Embedding returned 1 vectors for 2 texts');

    globalThis.fetch = embeddings([{ index: 0, embedding: [0.1, 0.2] }]);
    await expect(embedder.embed(['a'])).rejects.toThrow(ProviderError);
  });

  it('classifies a rate limit as retryable and a bad request as permanent', async () => {
    for (const [status, kind] of [
      [429, 'retryable'],
      [400, 'permanent'],
    ] as const) {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve({ ok: false, status, text: () => Promise.resolve('nope') } as unknown as Response),
      );

      const error = await embedder.embed(['a']).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe(kind);
      expect((error as ProviderError).message).toContain(`Embedding returned ${String(status)}`);
    }
  });

  it('refuses to call the provider at all with no key, and says what to do', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await expect(embedder.embed(['a'])).rejects.toThrow('OPENAI_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
