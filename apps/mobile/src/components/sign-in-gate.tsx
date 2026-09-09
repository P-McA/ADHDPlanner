import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { devModeEnabled } from '../lib/api-client';

/**
 * Stands between the app and every authenticated screen.
 *
 * It mirrors the web client's dev bypass and inherits its rule: the flag read
 * here decides only what the client *sends*, never what the API accepts. The
 * API honours `x-dev-user` solely under its own server-side `DEV_AUTH_BYPASS`
 * outside production, so flipping `EXPO_PUBLIC_DEV_MODE` in a shipped bundle
 * buys an attacker a header the server ignores.
 *
 * With the flag off it refuses to render rather than falling through to a
 * screen that would 401 on every request. Real Clerk sign-in on the phone is
 * not wired — `setAuthTokenProvider` is the seam it plugs into — and saying so
 * plainly is better than an empty task list that looks like an empty account.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  if (devModeEnabled()) return <>{children}</>;

  return (
    <View style={styles.container} testID="signed-out">
      <Text style={styles.heading}>Not signed in</Text>
      <Text style={styles.body}>
        This build has no session. Sign-in on mobile is not wired yet; for local
        development set EXPO_PUBLIC_DEV_MODE=true and run the API with
        DEV_AUTH_BYPASS=true.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 12, justifyContent: 'center', padding: 24 },
  heading: { fontSize: 22, fontWeight: '600' },
  body: { color: '#444', fontSize: 15, lineHeight: 22 },
});
