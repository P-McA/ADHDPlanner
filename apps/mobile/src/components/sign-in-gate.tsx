import { useAuth } from '@clerk/expo';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { clerkPublishableKey } from '../auth/clerk-session';
import { devModeEnabled } from '../lib/api-client';
import { SignInScreen } from './sign-in-screen';

/**
 * Stands between the app and every authenticated screen.
 *
 * With a Clerk publishable key in the bundle, a real session is required: the
 * sign-in screen until Clerk reports one, then the app with a sign-out bar.
 * The dev bypass is *not* a fallback in that mode — a build configured for
 * real sign-in that quietly fell back to `x-dev-user` would make "the API
 * accepted a real token" unprovable, which is the claim this exists for.
 *
 * With no key, it keeps the Phase 1.5 behaviour: `EXPO_PUBLIC_DEV_MODE=true`
 * lets the dev header through (honoured only under the API's own
 * `DEV_AUTH_BYPASS`), otherwise it says plainly that nobody is signed in.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  if (clerkPublishableKey() !== null) return <ClerkGate>{children}</ClerkGate>;

  if (devModeEnabled()) return <>{children}</>;

  return (
    <View style={styles.container} testID="signed-out">
      <Text style={styles.heading}>Not signed in</Text>
      <Text style={styles.body}>
        This build has no Clerk key and dev sign-in is off. Set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
        for real sign-in, or EXPO_PUBLIC_DEV_MODE=true with the API's DEV_AUTH_BYPASS=true for local
        development.
      </Text>
    </View>
  );
}

function ClerkGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, signOut } = useAuth();

  if (!isLoaded) {
    return (
      <View style={styles.container} testID="auth-loading">
        <ActivityIndicator />
      </View>
    );
  }

  if (isSignedIn !== true) return <SignInScreen />;

  return (
    <>
      <View style={styles.bar}>
        <Text style={styles.barText}>Signed in</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void signOut();
          }}
          testID="sign-out"
        >
          <Text style={styles.barLink}>Sign out</Text>
        </Pressable>
      </View>
      {children}
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
  heading: { fontSize: 22, fontWeight: '600' },
  body: { color: '#444', fontSize: 15, lineHeight: 22 },
  bar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  barText: { color: '#666', fontSize: 13 },
  barLink: { color: '#7c3aed', fontWeight: '600' },
});
