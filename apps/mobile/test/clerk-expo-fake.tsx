import type { ReactNode } from 'react';

/**
 * Stand-in for `@clerk/expo` (and `@clerk/expo/token-cache`) under Jest, wired
 * in by `moduleNameMapper`.
 *
 * The real SDK reaches for native modules and the network as soon as its
 * provider mounts. What these tests assert is *our* side: which screen the gate
 * shows for each session state, which Clerk calls the sign-in screen makes in
 * which order, and that a signed-in session's token reaches the API client.
 * Whether Clerk actually accepts a token is a different claim, proved against
 * the live instance — not here.
 */

type Result = Promise<{ error: { message?: string; longMessage?: string } | null }>;

export const clerkFake = {
  isLoaded: true,
  isSignedIn: false,
  token: 'session-token-from-clerk',
  /** What `signIn.status` reports after `create`. */
  statusAfterCreate: 'complete',
  createError: null as { message: string } | null,
  calls: [] as string[],
  reset(): void {
    this.isLoaded = true;
    this.isSignedIn = false;
    this.token = 'session-token-from-clerk';
    this.statusAfterCreate = 'complete';
    this.createError = null;
    this.calls.length = 0;
  },
};

const ok = (): Result => Promise.resolve({ error: null });

const signIn = {
  status: 'needs_identifier',
  create(params: { identifier?: string; password?: string }): Result {
    clerkFake.calls.push(
      `create:${params.identifier ?? ''}:${params.password === undefined ? 'nopw' : 'pw'}`,
    );
    if (clerkFake.createError !== null) return Promise.resolve({ error: clerkFake.createError });
    signIn.status = clerkFake.statusAfterCreate;

    return ok();
  },
  finalize(): Result {
    clerkFake.calls.push('finalize');

    return ok();
  },
  emailCode: {
    sendCode(): Result {
      clerkFake.calls.push('emailCode.sendCode');

      return ok();
    },
    verifyCode(params: { code: string }): Result {
      clerkFake.calls.push(`emailCode.verifyCode:${params.code}`);
      signIn.status = 'complete';

      return ok();
    },
  },
  mfa: {
    sendEmailCode(): Result {
      clerkFake.calls.push('mfa.sendEmailCode');

      return ok();
    },
    verifyEmailCode(params: { code: string }): Result {
      clerkFake.calls.push(`mfa.verifyEmailCode:${params.code}`);
      signIn.status = 'complete';

      return ok();
    },
  },
};

export function useSignIn() {
  return { signIn, fetchStatus: 'idle' as const, errors: {} };
}

export function useAuth() {
  return {
    isLoaded: clerkFake.isLoaded,
    isSignedIn: clerkFake.isSignedIn,
    getToken: () => Promise.resolve(clerkFake.token),
    signOut: () => {
      clerkFake.calls.push('signOut');

      return Promise.resolve();
    },
  };
}

export function ClerkProvider({ children }: { children: ReactNode; publishableKey: string }) {
  return <>{children}</>;
}

/** `@clerk/expo/token-cache` resolves here too. */
export const tokenCache = {};
