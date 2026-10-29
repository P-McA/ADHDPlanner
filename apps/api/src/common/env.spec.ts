import { describe, expect, it } from 'vitest';

import { assertProductionEnv, missingProductionEnv, REQUIRED_IN_PRODUCTION } from './env.js';

const complete = (): Record<string, string> =>
  Object.fromEntries(REQUIRED_IN_PRODUCTION.map((name) => [name, 'set']));

describe('missingProductionEnv', () => {
  it('is empty when every required variable is set', () => {
    expect(missingProductionEnv(complete())).toEqual([]);
  });

  it('names every absent and blank variable at once', () => {
    const env = { ...complete(), DATABASE_URL: undefined, REDIS_URL: '   ' };

    expect(missingProductionEnv(env)).toEqual(['DATABASE_URL', 'REDIS_URL']);
  });
});

describe('assertProductionEnv', () => {
  it('does nothing outside production', () => {
    expect(() => assertProductionEnv({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('refuses to boot a production process with a gap', () => {
    const env = { ...complete(), NODE_ENV: 'production', CLERK_SECRET_KEY: '' };

    expect(() => assertProductionEnv(env)).toThrow(/CLERK_SECRET_KEY/);
  });

  it('accepts a complete production environment', () => {
    expect(() => assertProductionEnv({ ...complete(), NODE_ENV: 'production' })).not.toThrow();
  });
});
