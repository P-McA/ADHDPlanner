import { z } from 'zod';

import type { DraftCandidate } from './ingestion.js';
import { TASK_PRIORITIES } from './task.js';

/**
 * What the extractor asks the model for, stated once.
 *
 * This is the *request* half of the contract: the API turns it into the JSON
 * schema it sends as `response_format` (strict mode), so the shape the prompt
 * describes and the shape the provider enforces cannot drift apart. Every
 * field is required and nullable rather than optional, because strict mode
 * requires every property to be listed — "absent" is spelled `null`.
 */
export const ExtractionResponseSchema = z.strictObject({
  tasks: z.array(
    z.strictObject({
      title: z.string(),
      dueAt: z.string().nullable(),
      manualPriority: z.enum(TASK_PRIORITIES).nullable(),
    }),
  ),
});

export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>;

/**
 * {@link ExtractionResponseSchema} as the JSON schema strict mode wants.
 * `$schema` is dropped: it is a meta-keyword the provider has no use for.
 */
export function extractionResponseJsonSchema(): Record<string, unknown> {
  const { $schema: _meta, ...schema } = z.toJSONSchema(ExtractionResponseSchema);

  return schema;
}

/**
 * The envelope, checked before any row is looked at. Rows are `unknown` here
 * on purpose: one bad row is dropped on its own (below), it does not sink the
 * memo.
 */
export const ExtractionEnvelopeSchema = z.object({ tasks: z.array(z.unknown()) });

/**
 * The *trust* half: what a single row must be before it becomes a draft.
 *
 * Strict mode guarantees the shape, not the content — a blank title and
 * "next tuesday-ish" are both valid strings. So a row without a usable title is
 * rejected outright (a guessed title is an invented task), while a due date or
 * priority that does not parse is nulled rather than kept: a draft whose fields
 * were made up looks more considered than it is.
 */
export const DraftCandidateSchema = z.object({
  title: z.string().trim().min(1),
  dueAt: z.iso.datetime({ offset: true }).nullable().catch(null),
  manualPriority: z.enum(TASK_PRIORITIES).nullable().catch(null),
}) satisfies z.ZodType<DraftCandidate>;
