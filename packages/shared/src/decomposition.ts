import { z } from 'zod';

import { TASK_TITLE_MAX_LENGTH } from './task.js';

/**
 * "Break this into steps": the contract between the API and the model.
 *
 * Same split as `extraction.ts`. {@link DecompositionResponseSchema} is what we
 * *ask* for, sent as the strict-mode `response_format`; {@link
 * StepCandidateSchema} is what one row must be before it becomes a draft step.
 */

/** At most this many steps. Ten small steps is a second to-do list, not help. */
export const MAX_STEPS = 7;

/** The deadline on the call. The user is watching a button, so it is short. */
export const DECOMPOSITION_TIMEOUT_MS = 30_000;

export const DecompositionResponseSchema = z.strictObject({
  steps: z.array(z.strictObject({ title: z.string() })),
});

export type DecompositionResponse = z.infer<typeof DecompositionResponseSchema>;

/** The envelope, checked before any row is: one bad step is dropped alone. */
export const DecompositionEnvelopeSchema = z.object({ steps: z.array(z.unknown()) });

/** {@link DecompositionResponseSchema} as the JSON schema strict mode wants. */
export function decompositionResponseJsonSchema(): Record<string, unknown> {
  const { $schema: _meta, ...schema } = z.toJSONSchema(DecompositionResponseSchema);

  return schema;
}

/** One step the model proposed. A blank title is rejected, never repaired. */
export const StepCandidateSchema = z.object({
  title: z.string().trim().min(1).max(TASK_TITLE_MAX_LENGTH),
});

export type StepCandidate = z.infer<typeof StepCandidateSchema>;

/**
 * The model's rows as usable steps, in its order: malformed rows dropped, a
 * step that merely restates the parent dropped (it adds a row and no help),
 * and the list cut at {@link MAX_STEPS}.
 */
export function toStepCandidates(rows: readonly unknown[], parentTitle?: string): StepCandidate[] {
  const parent = parentTitle?.trim().toLowerCase();
  const steps: StepCandidate[] = [];

  for (const row of rows) {
    const parsed = StepCandidateSchema.safeParse(row);

    if (!parsed.success) continue;
    if (parent !== undefined && parsed.data.title.toLowerCase() === parent) continue;

    steps.push(parsed.data);

    if (steps.length === MAX_STEPS) break;
  }

  return steps;
}
