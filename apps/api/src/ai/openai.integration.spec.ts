import { describe, expect, it } from 'vitest';

import { OpenAiExtractor } from './openai.extractor.js';

/**
 * The one test that talks to the real provider.
 *
 * Gated on `OPENAI_API_KEY` and skipped when it is absent, which is the normal
 * case: CI has no key, and neither does a checkout someone just cloned. The
 * unit tests around it prove the adapter's *handling* against a stubbed fetch;
 * what they cannot prove is that the request shape is one OpenAI actually
 * accepts — a wrong field name, a renamed model or a changed response envelope
 * looks identical to a stub. This is the check for that, and it is why it must
 * hit the network rather than a recording.
 *
 * Run it with:  OPENAI_API_KEY=sk-... pnpm --filter @adhd/api test
 *
 * It asserts only what the contract guarantees. Pinning the exact titles a
 * model returns would make it a test of the model's mood, failing on a
 * provider-side update that broke nothing — the claim here is "a real call
 * succeeds and comes back as parsed candidates", not "GPT said these words".
 *
 * Transcription is deliberately not covered: it would need a real audio
 * fixture committed to the repo and would bill per run. The failure mode this
 * catches — a request shape the provider rejects — is the same one for both
 * adapters, and both are built the same way.
 */
const hasKey = (process.env.OPENAI_API_KEY ?? '') !== '';

describe.skipIf(!hasKey)('OpenAiExtractor against the real API', () => {
  it('extracts a commitment from a memo and ignores the rest of it', async () => {
    const candidates = await new OpenAiExtractor().extract(
      "Ugh, the car's been making that noise again, my sister said her garage was great. " +
        'Anyway I need to book the car in before the MOT runs out.',
    );

    // At least the one commitment, and every row well-formed — the shape is
    // the contract, the wording is not.
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    for (const candidate of candidates) {
      expect(typeof candidate.title).toBe('string');
      expect(candidate.title.length).toBeGreaterThan(0);
      expect(candidate.dueAt === null || !Number.isNaN(Date.parse(candidate.dueAt))).toBe(true);
    }
  }, 60_000);

  it('returns nothing for a memo that is only thinking out loud', async () => {
    // The prompt's whole bias, checked against the real model: the expensive
    // failure is invention, not omission.
    const candidates = await new OpenAiExtractor().extract(
      "I'm just tired today. The weather's been miserable and I keep thinking about how " +
        'the summer went. My sister reckons her new job is going well.',
    );

    expect(candidates).toEqual([]);
  }, 60_000);
});
