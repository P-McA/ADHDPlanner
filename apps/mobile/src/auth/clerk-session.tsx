import { ClerkProvider, useAuth } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { type ReactNode, useEffect } from 'react';
import { Platform } from 'react-native';

import { setAuthTokenProvider } from '../lib/api-client';

/**
 * The Clerk publishable key the bundle was built with, or null.
 *
 * Publishable keys are public by design — they name the instance, nothing
 * more — so inlining one into the bundle via `EXPO_PUBLIC_` is correct. The
 * *secret* key lives only in the API's .env and must never appear here.
 */
export function clerkPublishableKey(): string | null {
  const key = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

  return key !== undefined && key.startsWith('pk_') ? key : null;
}

/**
 * Wraps the app in Clerk when a key is configured, and passes straight
 * through when it is not — so a checkout with no Clerk instance still runs on
 * the dev bypass exactly as before.
 *
 * The token cache keeps the session in the device's secure store (Keychain /
 * Keystore), so the user stays signed in across launches. `expo-secure-store`
 * has no web implementation, so Expo web gets no cache and Clerk falls back to
 * its own browser storage — the "web sign-in breaks" trap the architect
 * flagged.
 */
export function ClerkRoot({ children }: { children: ReactNode }) {
  const key = clerkPublishableKey();

  if (key === null) return <>{children}</>;

  return (
    <ClerkProvider publishableKey={key} {...(Platform.OS === 'web' ? {} : { tokenCache })}>
      <ClerkTokenBridge />
      {children}
    </ClerkProvider>
  );
}

/**
 * Connects Clerk's session to the API client's token seam.
 *
 * `getToken()` is asked per request, not cached here: session tokens live
 * about a minute, and Clerk refreshes them on demand. Signed out, the provider
 * returns null and the client sends no Authorization header at all.
 */
function ClerkTokenBridge() {
  const { isSignedIn, getToken } = useAuth();

  useEffect(() => {
    setAuthTokenProvider(() => (isSignedIn === true ? getToken() : null));

    return () => {
      setAuthTokenProvider(() => null);
    };
  }, [isSignedIn, getToken]);

  return null;
}
