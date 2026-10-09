import { ESTIMATE_BUCKETS, type EstimateMinutes } from '@adhd/shared';
import { describe, expect, it } from 'vitest';

import { OpenAiEstimator } from './openai.estimator.js';

/**
 * The "how long will this take?" eval set: real tasks, the real model, several
 * runs each.
 *
 * Double-gated (`OPENAI_API_KEY` **and** `ESTIMATION_EVAL=1`) like the other
 * evals: it is CASES × RUNS billed calls, so it never runs in `pnpm test` or
 * CI. Run it when the prompt, the model snapshot or the buckets change.
 *
 * What it asserts is the *band*, not one right answer — a bins run is not
 * "two hours", a tax return is not "five minutes" — and that runs agree to
 * within one bucket of each other, the same tolerance the decomposition eval
 * settled on: the snapshot and seed still drift by a step between calls.
 */

const RUNS = 3;

/** [title, description, lowest acceptable bucket, highest acceptable bucket]. */
const CASES: [string, string | null, EstimateMinutes, EstimateMinutes][] = [
  ['Text Sam back', null, 5, 15],
  ['Take the bins out', null, 5, 15],
  ['Pay the electricity bill', null, 5, 15],
  ['Book the car in for its MOT', null, 15, 60],
  ['Do the weekly food shop', null, 30, 120],
  ['Clean the kitchen', null, 30, 120],
  ['Write a cover letter for the job application', null, 30, 120],
  ['Plan Mum’s birthday dinner', 'Saturday, about eight people', 60, 240],
  ['Sort out the spare room', 'It has become a dumping ground', 120, 240],
  ['File my tax return', 'Self-assessment, deadline end of January', 120, 240],
];

const enabled = (process.env.OPENAI_API_KEY ?? '') !== '' && process.env.ESTIMATION_EVAL === '1';

const step = (minutes: EstimateMinutes): number => ESTIMATE_BUCKETS.indexOf(minutes);

describe.skipIf(!enabled)('estimation eval set (real model)', () => {
  const estimator = new OpenAiEstimator();

  it.concurrent.each(CASES)(
    'estimates %j inside its band, the same way every time',
    async (title, description, low, high) => {
      const runs = await Promise.all(
        Array.from({ length: RUNS }, () => estimator.estimate({ title, description })),
      );
      const steps = runs.map(step);
      const label = `estimates across runs: ${JSON.stringify(runs)}`;

      // Every run inside the band…
      expect(Math.min(...steps), label).toBeGreaterThanOrEqual(step(low));
      expect(Math.max(...steps), label).toBeLessThanOrEqual(step(high));
      // …and the runs within one bucket of each other.
      expect(Math.max(...steps) - Math.min(...steps), label).toBeLessThanOrEqual(1);
    },
    120_000,
  );
});
