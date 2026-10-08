import {
  DraftCandidateSchema,
  EXTRACTION_TIMEOUT_MS,
  ExtractionEnvelopeSchema,
  extractionResponseJsonSchema,
  type DraftCandidate,
} from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';

import type { Extractor } from './ai.ports.js';
import { EXTRACTION_SYSTEM_PROMPT, extractionUserPrompt } from './extraction.prompt.js';
import { openAiKey, OPENAI_BASE_URL } from './openai.config.js';
import { ProviderError } from './provider-error.js';

const COMPLETIONS_URL = `${OPENAI_BASE_URL}/chat/completions`;

/**
 * A dated snapshot, never the floating `gpt-4o` alias. The alias moves when
 * OpenAI repoints it, and a silent model change is exactly the drift the eval
 * set exists to catch — it should arrive as a diff to this line, not as a day
 * when the drafts quietly got worse.
 */
export const EXTRACTION_MODEL = 'gpt-4o-2024-11-20';

/**
 * Best-effort determinism on top of `temperature: 0`. OpenAI does not promise
 * identical output even with both, which is why the eval set measures it
 * rather than assuming it.
 */
export const EXTRACTION_SEED = 7;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'extraction', strict: true, schema: extractionResponseJsonSchema() },
} as const;

@Injectable()
export class OpenAiExtractor implements Extractor {
  private readonly logger = new Logger(OpenAiExtractor.name);

  async extract(transcript: string): Promise<DraftCandidate[]> {
    const response = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openAiKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        // Extraction, not authorship. Sampling variety is exactly the wrong
        // thing here: the same memo should yield the same drafts.
        temperature: 0,
        seed: EXTRACTION_SEED,
        // Strict mode: the provider enforces the shared contract's shape, so
        // the prompt no longer has to beg for it.
        response_format: RESPONSE_FORMAT,
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: extractionUserPrompt(transcript, new Date()) },
        ],
      }),
      signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '<unreadable>')).slice(0, 300);
      throw ProviderError.fromStatus(`Extraction returned ${response.status}: ${detail}`, response.status);
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown; refusal?: unknown } }[];
    };
    const message = body.choices?.[0]?.message;
    const content = message?.content;

    // Strict mode reports a safety refusal here instead of in `content`.
    if (typeof message?.refusal === 'string' && message.refusal !== '') {
      throw new Error(`Extraction was refused: ${message.refusal.slice(0, 300)}`);
    }

    if (typeof content !== 'string') {
      throw new Error('Extraction returned no message content');
    }

    return this.parse(content);
  }

  /**
   * Turns the model's JSON into candidates, dropping anything malformed.
   *
   * Every field is re-validated rather than trusted. Strict mode guarantees
   * the *shape*, not the content — and the one thing this pipeline must never
   * do is let a plausible-looking hallucination through as structured data. A
   * row that fails `DraftCandidateSchema` is dropped rather than repaired: a
   * guessed title is exactly the invented task the prompt spends its length
   * trying to avoid.
   */
  private parse(content: string): DraftCandidate[] {
    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Extraction returned content that is not JSON');
    }

    const envelope = ExtractionEnvelopeSchema.safeParse(parsed);

    if (!envelope.success) {
      throw new Error('Extraction returned no tasks array');
    }

    const candidates: DraftCandidate[] = [];

    for (const raw of envelope.data.tasks) {
      const candidate = DraftCandidateSchema.safeParse(raw);

      if (!candidate.success) {
        this.logger.warn(`Dropped a malformed extraction row: ${JSON.stringify(raw).slice(0, 200)}`);
        continue;
      }

      candidates.push(candidate.data);
    }

    return candidates;
  }
}
