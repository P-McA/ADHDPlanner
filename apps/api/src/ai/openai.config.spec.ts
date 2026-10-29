import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertAiEnabled, openAiKey } from './openai.config.js';

const original = { key: process.env.OPENAI_API_KEY, kill: process.env.AI_KILL_SWITCH };

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_KILL_SWITCH;
});

afterEach(() => {
  if (original.key === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = original.key;

  if (original.kill === undefined) delete process.env.AI_KILL_SWITCH;
  else process.env.AI_KILL_SWITCH = original.kill;
});

describe('openAiKey', () => {
  it('returns the key when set', () => {
    process.env.OPENAI_API_KEY = 'sk_test';

    expect(openAiKey()).toBe('sk_test');
  });

  it('names the variable when it is missing', () => {
    expect(() => openAiKey()).toThrow(/OPENAI_API_KEY/);
  });
});

describe('assertAiEnabled', () => {
  it('allows calls by default', () => {
    expect(() => assertAiEnabled()).not.toThrow();
  });

  it('refuses every call while the kill switch is on', () => {
    process.env.AI_KILL_SWITCH = 'true';

    expect(() => assertAiEnabled()).toThrow(/AI_KILL_SWITCH/);
  });
});
