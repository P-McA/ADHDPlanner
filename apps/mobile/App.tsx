import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, StyleSheet } from 'react-native';

import { HomeScreen } from './src/components/home-screen';
import { SignInGate } from './src/components/sign-in-gate';

/**
 * The Phase 1.5 mobile shell: sign-in gate, task list, complete, XP header,
 * and a voice-memo upload. Nothing else — the web app remains the full client.
 */
export default function App() {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="auto" />
      <SignInGate>
        <HomeScreen />
      </SignInGate>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#fff', flex: 1 },
});
