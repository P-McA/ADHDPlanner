import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getMe, markOnboarded } from '../lib/api-client';
import { radius, space, TAP, type ThemeColors, type as typeScale, useTheme } from '../theme/theme';

const STEPS = [
  {
    icon: 'mic-outline' as const,
    title: 'Get it out of your head',
    body: 'Type it, say it, or photograph it. One tap, before it slips.',
  },
  {
    icon: 'sparkles-outline' as const,
    title: 'Nothing is a task until you say so',
    body: 'Voice notes and photos become suggestions. You add the ones that are real.',
  },
  {
    icon: 'arrow-up-circle-outline' as const,
    title: 'Start with one thing',
    body: 'Next up puts the most urgent, quickest win at the top. Finish it and the streak grows.',
  },
];

/**
 * The first-run explanation, shown once per account.
 *
 * The flag is server-side (`users.onboarded_at`) rather than local, so a
 * reinstall does not replay it and a second device does not show it again.
 *
 * It never traps the user: if the profile cannot be read, or marking it seen
 * fails, the screen goes away anyway. An explanation that blocks the app
 * because the API is down is worse than one that is missed.
 */
export function Onboarding() {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getMe()
      .then((user) => {
        if (!cancelled) setVisible(user.onboardedAt === null);
      })
      .catch(() => {
        // Unknown is not "show it": a flash of onboarding on every launch
        // while the API is down would be worse than silence.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  function dismiss(): void {
    setVisible(false);
    // Fire and forget: the screen is already gone, and a failure only means it
    // may appear again next launch.
    void markOnboarded().catch(() => undefined);
  }

  return (
    <View style={styles.overlay} testID="onboarding">
      <View style={styles.card}>
        <Text style={styles.heading}>A calmer way to keep track</Text>

        {STEPS.map((step) => (
          <View key={step.title} style={styles.step}>
            <Ionicons name={step.icon} size={22} color={colors.accent} />
            <View style={styles.stepText}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.stepBody}>{step.body}</Text>
            </View>
          </View>
        ))}

        <Pressable
          accessibilityRole="button"
          onPress={dismiss}
          style={styles.button}
          testID="onboarding-dismiss"
        >
          <Text style={styles.buttonText}>Got it</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    overlay: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: colors.background,
      justifyContent: 'center',
      padding: space.lg,
      zIndex: 10,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.lg,
      borderWidth: 1,
      gap: space.lg,
      padding: space.xl,
    },
    heading: { ...typeScale.title, color: colors.text },
    step: { flexDirection: 'row', gap: space.md },
    stepText: { flex: 1, gap: 2 },
    stepTitle: { ...typeScale.label, color: colors.text },
    stepBody: { ...typeScale.small, color: colors.textMuted },
    button: {
      alignItems: 'center',
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
      justifyContent: 'center',
      minHeight: TAP,
    },
    buttonText: { ...typeScale.label, color: colors.onAccent },
  });
}
