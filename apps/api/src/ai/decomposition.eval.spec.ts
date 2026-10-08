import { MAX_STEPS } from '@adhd/shared';
import { describe, expect, it } from 'vitest';

import { OpenAiDecomposer } from './openai.decomposer.js';

/**
 * The "Break this into steps" eval set: real tasks, the real model, several
 * runs each.
 *
 * Double-gated (`OPENAI_API_KEY` **and** `DECOMPOSITION_EVAL=1`) for the same
 * reason as the extraction eval: it is CASES × RUNS billed calls, so it never
 * runs in `pnpm test` or CI. Run it when the prompt, the model snapshot or the
 * schema changes.
 *
 * What it asserts is shape, not wording — the right *kind* of answer, and the
 * same kind every time:
 * - a task with several moves in it is broken into 2..MAX_STEPS steps, with
 *   counts within one of each other across runs. A wider swing (3, 5, 3)
 *   means the user gets a different plan for pressing the button twice.
 * - a task that is already one action comes back empty. Inventing "steps" for
 *   "text Sam back" is the over-eager failure: busywork that looks like help,
 *   and the user pays for it in review taps.
 */

const RUNS = 3;

/** [title, description, expectation] — `split` means 2..MAX_STEPS, `atomic` means none. */
const CASES: [string, string | null, 'split' | 'atomic'][] = [
  ['Book the car in for its MOT', null, 'split'],
  ['Clean the kitchen', null, 'split'],
  ['File my tax return', 'Self-assessment, deadline end of January', 'split'],
  ['Plan Mum’s birthday dinner', 'Saturday, about eight people', 'split'],
  ['Move to the new energy supplier', null, 'split'],
  ['Sort out the spare room', 'It has become a dumping ground', 'split'],
  ['Get a new passport', 'Current one expires in March', 'split'],
  ['Prepare for the job interview on Thursday', null, 'split'],
  ['Text Sam back', null, 'atomic'],
  ['Take the bins out', null, 'atomic'],
];

const enabled = (process.env.OPENAI_API_KEY ?? '') !== '' && process.env.DECOMPOSITION_EVAL === '1';

describe.skipIf(!enabled)('decomposition eval set (real model)', () => {
  const decomposer = new OpenAiDecomposer();

  it.concurrent.each(CASES)(
    'breaks %j down the same way every time',
    async (title, description, expectation) => {
      const runs = await Promise.all(
        Array.from({ length: RUNS }, () => decomposer.decompose({ title, description })),
      );
      const counts = runs.map((steps) => steps.length);

      // One assertion per property over the whole run, so a failure shows the
      // flicker ([3, 5, 3]) rather than just the first odd number.
      if (expectation === 'atomic') {
        expect(counts).toEqual(Array.from({ length: RUNS }, () => 0));

        return;
      }

      // Within one step of each other, not identical. Measured 2026-10-09: the
      // pinned snapshot with a fixed seed still drifts by one step between
      // calls (6/5/5, 7/6/7, 5/6/6), on different tasks from run to run and
      // whatever the prompt said — model noise, not a prompt fault. A plan of
      // 5 one time and 6 the next is still a sensible plan, and the user only
      // ever sees one: a second press is refused while suggestions wait.
      // A spread of 2+ would be a different plan, and still fails here.
      const spread = Math.max(...counts) - Math.min(...counts);

      expect(spread, `counts across runs: ${JSON.stringify(counts)}`).toBeLessThanOrEqual(1);
      expect(Math.min(...counts)).toBeGreaterThanOrEqual(2);
      expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_STEPS);
    },
    120_000,
  );
});
