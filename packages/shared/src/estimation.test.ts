import { describe, expect, it } from 'vitest';

import {
  ESTIMATE_BUCKETS,
  EstimationResponseSchema,
  estimationResponseJsonSchema,
  formatEstimate,
  isEstimateMinutes,
  toEstimateMinutes,
} from './estimation.js';
import { XP_DRAFT_REVIEW, XP_ESTIMATE_REVIEW, XP_EVENT_TYPES } from './gamification.js';

describe('ESTIMATE_BUCKETS', () => {
  it('is the owner’s six buckets, smallest first', () => {
    // Coarse on purpose: a model saying "37 minutes" is false precision, and
    // the question an estimate answers is "does this fit before I have to go".
    expect(ESTIMATE_BUCKETS).toEqual([5, 15, 30, 60, 120, 240]);
  });
});

describe('isEstimateMinutes', () => {
  it.each([5, 15, 30, 60, 120, 240])('accepts the bucket %i', (minutes) => {
    expect(isEstimateMinutes(minutes)).toBe(true);
  });

  it.each([0, 1, 37, 45, 241, -30, 30.5, Number.NaN])('refuses %d, which is not a bucket', (minutes) => {
    expect(isEstimateMinutes(minutes)).toBe(false);
  });

  it('refuses anything that is not a number at all', () => {
    expect(isEstimateMinutes('30')).toBe(false);
    expect(isEstimateMinutes(null)).toBe(false);
  });
});

describe('toEstimateMinutes', () => {
  it('passes a bucket through', () => {
    expect(toEstimateMinutes(60)).toBe(60);
  });

  it('returns null for anything that is not a bucket, rather than rounding it into one', () => {
    // Snapping 37 to 30 would store a guess about a guess. Null means "the
    // model did not give us a usable answer", which the API reports as such.
    expect(toEstimateMinutes(37)).toBeNull();
    expect(toEstimateMinutes(undefined)).toBeNull();
  });
});

describe('EstimationResponseSchema', () => {
  it('accepts one bucket', () => {
    expect(EstimationResponseSchema.parse({ minutes: 15 })).toEqual({ minutes: 15 });
  });

  it('rejects a number that is not a bucket, and any extra field', () => {
    expect(EstimationResponseSchema.safeParse({ minutes: 37 }).success).toBe(false);
    expect(EstimationResponseSchema.safeParse({ minutes: 15, reason: 'x' }).success).toBe(false);
  });
});

describe('estimationResponseJsonSchema', () => {
  it('pins the model to the buckets, in the form strict mode accepts', () => {
    const schema = estimationResponseJsonSchema();

    expect(schema).not.toHaveProperty('$schema');
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['minutes'],
    });
    expect(JSON.stringify(schema)).toContain('[5,15,30,60,120,240]');
  });
});

describe('formatEstimate', () => {
  it.each([
    [5, '~5 min'],
    [15, '~15 min'],
    [30, '~30 min'],
    [60, '~1 hr'],
    [120, '~2 hr'],
    [240, '4 hr+'],
  ] as const)('shows %i minutes as %s', (minutes, label) => {
    // The top bucket is open-ended: "about four hours" for a day-long job
    // would be a promise the number cannot keep.
    expect(formatEstimate(minutes)).toBe(label);
  });
});

describe('estimate review XP', () => {
  it('pays the same as reviewing a draft, and is its own ledger type', () => {
    expect(XP_ESTIMATE_REVIEW).toBe(XP_DRAFT_REVIEW);
    expect(XP_EVENT_TYPES).toContain('estimate_reviewed');
  });
});
