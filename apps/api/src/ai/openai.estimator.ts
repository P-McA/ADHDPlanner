import {
  ESTIMATION_TIMEOUT_MS,
  estimationResponseJsonSchema,
  toEstimateMinutes,
  type EstimateMinutes,
} from '@adhd/shared';
import { Injectable } from '@nestjs/common';

import type { EstimationInput, Estimator } from './ai.ports.js';
import { ESTIMATION_SYSTEM_PROMPT, estimationUserPrompt } from './estimation.prompt.js';
import { openAiKey, OPENAI_BASE_URL } from './openai.config.js';
import { ProviderError } from './provider-error.js';

const COMPLETIONS_URL = `${OPENAI_BASE_URL}/chat/completions`;

/** A dated snapshot, never the floating alias — same rule as extraction. */
export const ESTIMATION_MODEL = 'gpt-4o-2024-11-20';

/** Best-effort determinism on top of `temperature: 0`. */
export const ESTIMATION_SEED = 7;

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'estimation', strict: true, schema: estimationResponseJsonSchema() },
} as const;

/**
 * "How long will this take?" against OpenAI. The only file that may send a
 * task to OpenAI for an estimate, the same rule the other adapters keep. The
 * answer is a bucket; whether it becomes a suggestion on the task is the tasks
 * service's business.
 */
@Injectable()
export class OpenAiEstimator implements Estimator {
  async estimate(task: EstimationInput): Promise<EstimateMinutes> {
    const response = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openAiKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ESTIMATION_MODEL,
        temperature: 0,
        seed: ESTIMATION_SEED,
        response_format: RESPONSE_FORMAT,
        messages: [
          { role: 'system', content: ESTIMATION_SYSTEM_PROMPT },
          { role: 'user', content: estimationUserPrompt(task.title, task.description) },
        ],
      }),
      signal: AbortSignal.timeout(ESTIMATION_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '<unreadable>')).slice(0, 300);

      throw ProviderError.fromStatus(
        `Estimation returned ${String(response.status)}: ${detail}`,
        response.status,
      );
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown; refusal?: unknown } }[];
    };
    const message = body.choices?.[0]?.message;

    if (typeof message?.refusal === 'string' && message.refusal !== '') {
      throw new ProviderError(`Estimation was refused: ${message.refusal.slice(0, 300)}`, 'permanent');
    }

    if (typeof message?.content !== 'string') {
      throw new ProviderError('Estimation returned no message content', 'permanent');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(message.content);
    } catch {
      throw new ProviderError('Estimation returned content that is not JSON', 'permanent');
    }

    const minutes = toEstimateMinutes((parsed as { minutes?: unknown } | null)?.minutes);

    if (minutes === null) {
      throw new ProviderError('Estimation returned no usable estimate', 'permanent');
    }

    return minutes;
  }
}
