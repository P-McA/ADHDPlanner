import {
  DraftCandidateSchema,
  EXTRACTION_TIMEOUT_MS,
  ExtractionEnvelopeSchema,
  extractionResponseJsonSchema,
  type DraftCandidate,
} from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';

import type { VisionExtractor } from './ai.ports.js';
import { EXTRACTION_SEED, EXTRACTION_MODEL } from './openai.extractor.js';
import { VISION_SYSTEM_PROMPT, visionUserPrompt } from './extraction.prompt.js';
import { assertAiEnabled, openAiKey, OPENAI_BASE_URL } from './openai.config.js';
import { ProviderError } from './provider-error.js';

const COMPLETIONS_URL = `${OPENAI_BASE_URL}/chat/completions`;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'extraction', strict: true, schema: extractionResponseJsonSchema() },
} as const;

/**
 * A photo to task drafts.
 *
 * Deliberately the same model snapshot, seed and strict schema as the text
 * extractor: the two paths must not drift in what they consider a valid
 * answer, and a vision model that silently changed under us is the same
 * failure the eval set exists to catch.
 */
@Injectable()
export class OpenAiVisionExtractor implements VisionExtractor {
  private readonly logger = new Logger(OpenAiVisionExtractor.name);

  async extract(image: Buffer, mimetype: string): Promise<DraftCandidate[]> {
    assertAiEnabled();

    const dataUrl = `data:${mimetype};base64,${image.toString('base64')}`;

    const response = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openAiKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        temperature: 0,
        seed: EXTRACTION_SEED,
        response_format: RESPONSE_FORMAT,
        messages: [
          { role: 'system', content: VISION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: visionUserPrompt(new Date()) },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '<unreadable>')).slice(0, 300);
      throw ProviderError.fromStatus(
        `Vision extraction returned ${response.status}: ${detail}`,
        response.status,
      );
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown; refusal?: unknown } }[];
    };
    const message = body.choices?.[0]?.message;
    const content = message?.content;

    if (typeof message?.refusal === 'string' && message.refusal !== '') {
      throw new Error(`Vision extraction was refused: ${message.refusal.slice(0, 300)}`);
    }

    if (typeof content !== 'string') {
      throw new Error('Vision extraction returned no message content');
    }

    return this.parse(content);
  }

  /** Same rule as the text extractor: strict mode guarantees shape, not content. */
  private parse(content: string): DraftCandidate[] {
    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Vision extraction returned content that is not JSON');
    }

    const envelope = ExtractionEnvelopeSchema.safeParse(parsed);

    if (!envelope.success) {
      throw new Error('Vision extraction returned no tasks array');
    }

    const candidates: DraftCandidate[] = [];

    for (const raw of envelope.data.tasks) {
      const candidate = DraftCandidateSchema.safeParse(raw);

      if (!candidate.success) {
        this.logger.warn(
          `Dropped a malformed vision extraction row: ${JSON.stringify(raw).slice(0, 200)}`,
        );
        continue;
      }

      candidates.push(candidate.data);
    }

    return candidates;
  }
}
