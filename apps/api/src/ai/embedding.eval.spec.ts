import { describe, expect, it } from 'vitest';

import { DUPLICATE_MIN_SIMILARITY, NEIGHBOUR_MIN_SIMILARITY } from '../predictions/prediction.constants.js';
import { OpenAiEmbedder } from './openai.embedder.js';

/**
 * Calibration for "Suggest tasks": do the two similarity cut-offs separate
 * what they claim to, against the real embedding model?
 *
 * - NEIGHBOUR: "the same kind of task" — two MOT bookings, two dentist
 *   appointments — must clear it; different kinds of task must not.
 * - DUPLICATE: "the same task, reworded" must clear it; merely the same kind
 *   ("Book the MOT" vs "Pay for the MOT") must not, or a follow-on would be
 *   thrown away as a copy of the thing it follows.
 *
 * Double-gated (`OPENAI_API_KEY` **and** `EMBEDDING_EVAL=1`) like the other
 * evals. Re-run it when the model or the cut-offs change; the measured values
 * are printed so the next calibration starts from numbers, not memory.
 */

const SAME_KIND: [string, string][] = [
  ['Book the car in for its MOT', 'Book MOT for the car'],
  ['Dentist appointment', 'Book a check-up at the dentist'],
  ['Pay the electricity bill', 'Pay the gas and electric bill'],
  ['Do the weekly food shop', 'Big supermarket shop'],
];

const DIFFERENT_KIND: [string, string][] = [
  ['Book the car in for its MOT', 'Do the weekly food shop'],
  ['Dentist appointment', 'Pay the electricity bill'],
  ['Clean the kitchen', 'File my tax return'],
  ['Text Sam back', 'Sort out the spare room'],
];

// Near-identical wording: what DUPLICATE is set to catch. Looser rewordings
// ("Book the dentist" / "Book dentist appointment", 0.767) overlap with
// follow-ons and are deliberately not asserted — see prediction.constants.ts.
const REWORDED: [string, string][] = [
  ['Pay for the MOT', 'pay for MOT'],
  ['Take the bins out', 'Take bins out'],
];

const FOLLOW_ON: [string, string][] = [
  ['Book the MOT', 'Pay for the MOT'],
  ['Book the dentist', 'Go to the dentist'],
  ['Order the birthday cake', 'Pick up the birthday cake'],
];

const enabled = (process.env.OPENAI_API_KEY ?? '') !== '' && process.env.EMBEDDING_EVAL === '1';

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }

  return dot / Math.sqrt(na * nb);
};

describe.skipIf(!enabled)('embedding calibration (real model)', () => {
  it('separates same-kind from different-kind, and rewordings from follow-ons', async () => {
    const groups = { SAME_KIND, DIFFERENT_KIND, REWORDED, FOLLOW_ON };
    const texts = Object.values(groups).flat(2);
    const vectors = await new OpenAiEmbedder().embed(texts);
    const at = new Map(texts.map((text, i) => [text, vectors[i]!]));
    const score = ([a, b]: [string, string]): number => cosine(at.get(a)!, at.get(b)!);
    const measured = Object.fromEntries(
      Object.entries(groups).map(([name, pairs]) => [name, pairs.map((pair) => Number(score(pair).toFixed(3)))]),
    ) as Record<keyof typeof groups, number[]>;

    // The numbers, for the next calibration.
    console.log('embedding calibration', JSON.stringify(measured), {
      NEIGHBOUR_MIN_SIMILARITY,
      DUPLICATE_MIN_SIMILARITY,
    });

    for (const value of measured.SAME_KIND) expect(value).toBeGreaterThanOrEqual(NEIGHBOUR_MIN_SIMILARITY);
    for (const value of measured.DIFFERENT_KIND) expect(value).toBeLessThan(NEIGHBOUR_MIN_SIMILARITY);
    for (const value of measured.REWORDED) expect(value).toBeGreaterThanOrEqual(DUPLICATE_MIN_SIMILARITY);
    for (const value of measured.FOLLOW_ON) expect(value).toBeLessThan(DUPLICATE_MIN_SIMILARITY);
  }, 60_000);
});
