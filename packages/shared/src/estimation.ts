import { z } from 'zod';

/**
 * "How long will this take?": the contract between the API, the model and
 * both clients.
 *
 * Same split as `decomposition.ts`: {@link EstimationResponseSchema} is what
 * we *ask* for, sent as the strict-mode `response_format`, so the model can
 * only answer with one of the buckets.
 *
 * An estimate the model suggests is a draft. It lives in
 * `Task.suggestedEstimateMinutes` until the user accepts it (or a corrected
 * bucket) into `Task.estimateMinutes`, which is theirs. The two never mix.
 */

/**
 * The owner's buckets (2026-10-09). Coarse on purpose: "37 minutes" from a
 * model is false precision, and the question an estimate answers is "does
 * this fit before I have to go". The top bucket is open-ended — "4 hr+".
 */
export const ESTIMATE_BUCKETS = [5, 15, 30, 60, 120, 240] as const;

export type EstimateMinutes = (typeof ESTIMATE_BUCKETS)[number];

/** The deadline on the call. The user is watching a button, so it is short. */
export const ESTIMATION_TIMEOUT_MS = 30_000;

export function isEstimateMinutes(value: unknown): value is EstimateMinutes {
  return typeof value === 'number' && (ESTIMATE_BUCKETS as readonly number[]).includes(value);
}

/**
 * A bucket, or null. Never rounds: snapping 37 to 30 would store a guess about
 * a guess, and null lets the API say the model gave no usable answer.
 */
export function toEstimateMinutes(value: unknown): EstimateMinutes | null {
  return isEstimateMinutes(value) ? value : null;
}

export const EstimationResponseSchema = z.strictObject({
  minutes: z.union(ESTIMATE_BUCKETS.map((bucket) => z.literal(bucket))),
});

export type EstimationResponse = z.infer<typeof EstimationResponseSchema>;

/** {@link EstimationResponseSchema} as the JSON schema strict mode wants. */
export function estimationResponseJsonSchema(): Record<string, unknown> {
  const { $schema: _meta, ...rest } = z.toJSONSchema(EstimationResponseSchema);

  // A union of literals comes out as `anyOf: [{const: 5}, …]`. Strict mode
  // accepts that, but a single `enum` is what the API documents and is what
  // the model is best at honouring, so the property is restated as one.
  return {
    ...rest,
    properties: { minutes: { type: 'integer', enum: [...ESTIMATE_BUCKETS] } },
  };
}

/** How an estimate reads on screen, on both clients. */
export function formatEstimate(minutes: EstimateMinutes): string {
  if (minutes === 240) return '4 hr+';
  if (minutes >= 60) return `~${String(minutes / 60)} hr`;

  return `~${String(minutes)} min`;
}
