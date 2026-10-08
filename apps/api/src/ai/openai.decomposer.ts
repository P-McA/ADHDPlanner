import {
  DecompositionEnvelopeSchema,
  DECOMPOSITION_TIMEOUT_MS,
  decompositionResponseJsonSchema,
  toStepCandidates,
  type StepCandidate,
} from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';

import type { Decomposer, DecompositionInput } from './ai.ports.js';
import { DECOMPOSITION_SYSTEM_PROMPT, decompositionUserPrompt } from './decomposition.prompt.js';
import { openAiKey, OPENAI_BASE_URL } from './openai.config.js';
import { ProviderError } from './provider-error.js';

const COMPLETIONS_URL = `${OPENAI_BASE_URL}/chat/completions`;

/** A dated snapshot, never the floating alias — same rule as extraction. */
export const DECOMPOSITION_MODEL = 'gpt-4o-2024-11-20';

/** Best-effort determinism on top of `temperature: 0`. */
export const DECOMPOSITION_SEED = 7;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'decomposition', strict: true, schema: decompositionResponseJsonSchema() },
} as const;

/**
 * "Break this into steps" against OpenAI. The only file that may send a task
 * to OpenAI for decomposition, the same rule the transcriber and extractor
 * keep. Steps come back as candidates; whether they become draft rows is the
 * tasks service's business.
 */
@Injectable()
export class OpenAiDecomposer implements Decomposer {
  private readonly logger = new Logger(OpenAiDecomposer.name);

  async decompose(task: DecompositionInput): Promise<StepCandidate[]> {
    const response = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openAiKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: DECOMPOSITION_MODEL,
        temperature: 0,
        seed: DECOMPOSITION_SEED,
        response_format: RESPONSE_FORMAT,
        messages: [
          { role: 'system', content: DECOMPOSITION_SYSTEM_PROMPT },
          { role: 'user', content: decompositionUserPrompt(task.title, task.description) },
        ],
      }),
      signal: AbortSignal.timeout(DECOMPOSITION_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '<unreadable>')).slice(0, 300);

      throw ProviderError.fromStatus(
        `Decomposition returned ${String(response.status)}: ${detail}`,
        response.status,
      );
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown; refusal?: unknown } }[];
    };
    const message = body.choices?.[0]?.message;

    if (typeof message?.refusal === 'string' && message.refusal !== '') {
      throw new ProviderError(`Decomposition was refused: ${message.refusal.slice(0, 300)}`, 'permanent');
    }

    if (typeof message?.content !== 'string') {
      throw new ProviderError('Decomposition returned no message content', 'permanent');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(message.content);
    } catch {
      throw new ProviderError('Decomposition returned content that is not JSON', 'permanent');
    }

    const envelope = DecompositionEnvelopeSchema.safeParse(parsed);

    if (!envelope.success) {
      throw new ProviderError('Decomposition returned no steps array', 'permanent');
    }

    const steps = toStepCandidates(envelope.data.steps, task.title);

    if (steps.length < envelope.data.steps.length) {
      this.logger.warn(
        `Kept ${String(steps.length)} of ${String(envelope.data.steps.length)} proposed steps`,
      );
    }

    return steps;
  }
}
