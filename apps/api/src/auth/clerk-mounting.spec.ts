import { afterEach, describe, expect, it } from 'vitest';

import { shouldMountClerk } from './clerk-mounting.js';

/**
 * Half of "no Clerk keys means 401, not 500".
 *
 * The other half is `ClerkAuthGuard` turning `getAuth`'s throw into 401, and
 * the pair is exercised end to end in `test/auth.e2e-spec.ts`
 * (`answers 401 rather than 500 on a server assembled with no Clerk keys`).
 * This file pins the bootstrap decision itself, which no e2e can reach:
 * `bootstrap()` runs at import time and binds a port.
 */

const originalKey = process.env.CLERK_PUBLISHABLE_KEY;
const originalBypass = process.env.DEV_AUTH_BYPASS;

const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

afterEach(() => {
  restore('CLERK_PUBLISHABLE_KEY', originalKey);
  restore('DEV_AUTH_BYPASS', originalBypass);
});

describe('shouldMountClerk', () => {
  it('mounts Clerk when the key is shaped like a real one', () => {
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk';

    expect(shouldMountClerk()).toBe(true);
  });

  it('mounts Clerk on a live key too', () => {
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_live_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk';

    expect(shouldMountClerk()).toBe(true);
  });

  it('does not mount Clerk when the key is absent', () => {
    delete process.env.CLERK_PUBLISHABLE_KEY;

    expect(shouldMountClerk()).toBe(false);
  });

  it('does not mount Clerk on the placeholder from .env.example', () => {
    // The dots are what disqualify it, and they are the reason the check is a
    // regex rather than a truthiness test: a developer who copied .env.example
    // and never filled it in has a key-shaped string that cannot work.
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_...';

    expect(shouldMountClerk()).toBe(false);
  });

  it('does not mount Clerk with no key even when the dev bypass is off', () => {
    // The regression this function exists for. The old rule was
    // `keyLooksUsable() || !devBypassArmed()`, so turning the bypass *off* —
    // the safer-looking setting — mounted middleware with no key, and Clerk
    // then failed every request before any route ran: 500 on the whole API,
    // GET /health included.
    delete process.env.CLERK_PUBLISHABLE_KEY;
    delete process.env.DEV_AUTH_BYPASS;

    expect(shouldMountClerk()).toBe(false);
  });

  it('mounts Clerk with a real key even while the dev bypass is armed', () => {
    // The opposite direction, so the fix cannot be read as "the bypass turns
    // Clerk off". A real key is always mounted; the bypass only decides who
    // may sign in without one.
    process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk';
    process.env.DEV_AUTH_BYPASS = 'true';

    expect(shouldMountClerk()).toBe(true);
  });
});
