import { EXTRACTION_TIMEOUT_MS, TASK_PRIORITIES, type DraftCandidate } from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';

import type { Extractor } from './ai.ports.js';
import { EXTRACTION_SYSTEM_PROMPT, extractionUserPrompt } from './extraction.prompt.js';
import { openAiKey, OPENAI_BASE_URL } from './openai.config.js';

const COMPLETIONS_URL = `${OPENAI_BASE_URL}/chat/completions`;
const MODEL = 'gpt-4o';

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
        model: MODEL,
        // Extraction, not authorship. Sampling variety is exactly the wrong
        // thing here: the same memo should yield the same drafts.
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: extractionUserPrompt(transcript, new Date()) },
        ],
      }),
      signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '<unreadable>')).slice(0, 300);
      throw new Error(`Extraction returned ${response.status}: ${detail}`);
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = body.choices?.[0]?.message?.content;

    if (typeof content !== 'string') {
      throw new Error('Extraction returned no message content');
    }

    return this.parse(content);
  }

  /**
   * Turns the model's JSON into candidates, dropping anything malformed.
   *
   * Every field is re-validated rather than trusted. `response_format` makes
   * the reply parseable JSON, not JSON of the right *shape* — and the one
   * thing this pipeline must never do is let a plausible-looking hallucination
   * through as structured data. A row that fails validation is dropped rather
   * than repaired: a guessed title is exactly the invented task the prompt
   * spends its length trying to avoid.
   */
  private parse(content: string): DraftCandidate[] {
    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Extraction returned content that is not JSON');
    }

    const tasks = (parsed as { tasks?: unknown }).tasks;

    if (!Array.isArray(tasks)) {
      throw new Error('Extraction returned no tasks array');
    }

    const candidates: DraftCandidate[] = [];

    for (const raw of tasks) {
      const candidate = toCandidate(raw);

      if (candidate === null) {
        this.logger.warn(`Dropped a malformed extraction row: ${JSON.stringify(raw).slice(0, 200)}`);
        continue;
      }

      candidates.push(candidate);
    }

    return candidates;
  }
}

function toCandidate(raw: unknown): DraftCandidate | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const { title, dueAt, manualPriority } = raw as Record<string, unknown>;

  if (typeof title !== 'string' || title.trim() === '') return null;

  return {
    title: title.trim(),
    dueAt: isIsoDate(dueAt) ? dueAt : null,
    manualPriority: isPriority(manualPriority) ? manualPriority : null,
  };
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isPriority(value: unknown): value is DraftCandidate['manualPriority'] & string {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
}
