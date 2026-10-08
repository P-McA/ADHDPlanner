import { describe, expect, it } from 'vitest';

import { OpenAiExtractor } from './openai.extractor.js';

/**
 * The extraction eval set: golden transcripts, each run several times against
 * the real model, asserting the draft *count* is both right and stable.
 *
 * Why the count and not the wording: the count is the product decision (did it
 * invent a task, did it miss a commitment), and it is the thing that visibly
 * flickered — "Reminder to self. Pay the electricity bill this week." made 0
 * drafts at 18:19:50 and 1 at 18:22:03 on 2026-10-07. Titles are allowed to
 * vary in phrasing; whether a commitment exists is not.
 *
 * Double-gated: an `OPENAI_API_KEY` *and* `EXTRACTION_EVAL=1`. It makes
 * CASES × RUNS billed calls, so having a key in your shell must not be enough
 * to run it by accident inside `pnpm test`. Run it with:
 *
 *   EXTRACTION_EVAL=1 OPENAI_API_KEY=sk-... pnpm --filter @adhd/api exec vitest run src/ai/extraction.eval.spec.ts
 *
 * Every case here should be unambiguous to a human reader. If a case is
 * arguable, it does not belong in a gate — move it to a notes file, do not
 * loosen the assertion.
 */
const RUNS = 5;

const CASES: readonly [transcript: string, expected: number][] = [
  // The one that flickered in production.
  ['Reminder to self. Pay the electricity bill this week.', 1],
  ['I need to book the car in before the MOT runs out.', 1],
  ["Don't let me forget to call Mum tomorrow evening.", 1],
  ['Urgent: renew the passport, it expires next month.', 1],
  ['First thing tomorrow I have to email the school about the trip form.', 1],
  ['Remind me to take the bins out tonight.', 1],
  ["Don't let me forget the dentist appointment on Thursday at 3.", 1],
  ['I need to buy milk on the way home.', 1],
  ['I have to pick up the prescription and also return the library books.', 2],
  ['Remind me to send the invoice to Sarah by Friday, and book a haircut.', 2],
  [
    "I need to renew the car insurance before the 15th, and I should ring the vet about Max's jab.",
    2,
  ],
  ['Okay, three things: call the bank, cancel the Netflix trial, and water the plants.', 3],
  // Real phone memos, 2026-10-08, which made 0 drafts: a bare instruction,
  // with no "I need to", is how people talk to a task app.
  ['Paint the ceiling in the living room white.', 1],
  ['Go to the shops and get some dog food.', 1],
  // Whisper's mishearing of "Paint". The real memo said "the roof and the
  // ceiling", which is arguably two jobs, so the gate uses one surface.
  ['Pant the living room ceiling.', 1],
  // Nothing to do — the expensive failure is invention, so these matter most.
  ["I'm just tired today. The weather's been miserable.", 0],
  ["I finally sent that email to the landlord, so that's done.", 0],
  ['My sister said her dentist was great.', 0],
  ["I could cancel the gym membership, but I won't.", 0],
  ['Tom is going to fix the fence this weekend.', 0],
  ['Thinking about whether I should learn Spanish someday. Probably not.', 0],
  ['The meeting went fine. Nothing else to report really.', 0],
  ["Ugh, the car's been making that noise again.", 0],
];

const enabled = (process.env.OPENAI_API_KEY ?? '') !== '' && process.env.EXTRACTION_EVAL === '1';

describe.skipIf(!enabled)('extraction eval set (real model)', () => {
  const extractor = new OpenAiExtractor();

  it.concurrent.each(CASES)(
    'finds the same number of tasks every time in %j',
    async (transcript, expected) => {
      const counts = await Promise.all(
        Array.from({ length: RUNS }, async () => (await extractor.extract(transcript)).length),
      );

      // One assertion over the whole run, so a failure shows the flicker
      // ([0, 1, 1, 0, 1]) rather than just the first wrong number.
      expect(counts).toEqual(Array.from({ length: RUNS }, () => expected));
    },
    120_000,
  );
});
