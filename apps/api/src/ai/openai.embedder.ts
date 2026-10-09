import { Injectable } from '@nestjs/common';

import type { Embedder } from './ai.ports.js';
import { openAiKey, OPENAI_BASE_URL } from './openai.config.js';
import { ProviderError } from './provider-error.js';

const EMBEDDINGS_URL = `${OPENAI_BASE_URL}/embeddings`;

/**
 * Owner-approved 2026-10-09. Embedding models have no dated snapshot; this
 * name is stable, and a change of model is a change of vector space, so every
 * stored embedding records the model it came from and is redone on a change.
 */
export const EMBEDDING_MODEL = 'text-embedding-3-small';

/** text-embedding-3-small's size; the `vector(1536)` column is pinned to it. */
export const EMBEDDING_DIMENSIONS = 1536;

/** The user is watching a button; one batch call, same deadline as the others. */
export const EMBEDDING_TIMEOUT_MS = 30_000;

/**
 * Texts to vectors against OpenAI. The only file that may send task text to
 * OpenAI for embedding, the same rule the other adapters keep. It measures
 * similarity and nothing else: no words come back, so nothing here can author
 * a task.
 */
@Injectable()
export class OpenAiEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openAiKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '<unreadable>')).slice(0, 300);

      throw ProviderError.fromStatus(`Embedding returned ${String(response.status)}: ${detail}`, response.status);
    }

    const body = (await response.json()) as { data?: { index?: unknown; embedding?: unknown }[] };
    const rows = body.data ?? [];

    if (rows.length !== texts.length) {
      throw new ProviderError(
        `Embedding returned ${String(rows.length)} vectors for ${String(texts.length)} texts`,
        'permanent',
      );
    }

    const vectors: number[][] = new Array<number[]>(texts.length);

    for (const row of rows) {
      const { index, embedding } = row;

      if (
        typeof index !== 'number' ||
        index < 0 ||
        index >= texts.length ||
        !Array.isArray(embedding) ||
        embedding.length !== EMBEDDING_DIMENSIONS ||
        !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        throw new ProviderError('Embedding returned a vector that is not usable', 'permanent');
      }

      vectors[index] = embedding as number[];
    }

    return vectors;
  }
}
