import { describe, expect, it } from 'vitest';

import { MAX_PREDICTIONS, predictionReason, sameTitle } from './prediction.js';

describe('predictions contract', () => {
  it('suggests at most three at a time — more is a second to-do list, not help', () => {
    expect(MAX_PREDICTIONS).toBe(3);
  });

  it('says which past task the suggestion followed, in the user’s own words', () => {
    expect(predictionReason('Book the MOT')).toBe('Last time, after “Book the MOT”');
  });

  it('trims a long past title rather than overflowing the line', () => {
    const reason = predictionReason('x'.repeat(200));

    expect(reason.length).toBeLessThanOrEqual(80);
    expect(reason.endsWith('…”')).toBe(true);
  });
});

describe('sameTitle', () => {
  it('treats case, spacing and trailing punctuation as the same task', () => {
    expect(sameTitle('Pay for the MOT', '  pay for the  mot. ')).toBe(true);
  });

  it('keeps genuinely different titles apart', () => {
    expect(sameTitle('Pay for the MOT', 'Book the MOT')).toBe(false);
  });
});
