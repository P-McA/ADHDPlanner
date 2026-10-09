import type { CreateTaskInput } from '@adhd/shared';
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ApiError, createTask } from '../lib/api-client';
import { radius, space, TAP, type ThemeColors, type as typeScale, useTheme } from '../theme/theme';

type When = 'today' | 'tomorrow' | null;

/** End of the chosen day on the phone's clock, so "due today" is not overdue by lunchtime. */
function endOfDay(when: Exclude<When, null>): string {
  const at = new Date();

  if (when === 'tomorrow') at.setDate(at.getDate() + 1);
  at.setHours(23, 59, 0, 0);

  return at.toISOString();
}

/**
 * Type a task. The user's own from the start — no review step, unlike a
 * suggestion — so it is the fastest way in, with only the two choices that
 * change where it ranks: when, and whether it matters more than usual.
 *
 * On a refusal the text stays put and the API's reason is shown; retyping a
 * thought you were trying not to lose is exactly the friction this exists to
 * remove.
 */
export function QuickAdd({ onAdded }: { onAdded: () => void }) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [title, setTitle] = useState('');
  const [when, setWhen] = useState<When>(null);
  const [high, setHigh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = title.trim();

    if (trimmed === '' || busy) return;

    const input: CreateTaskInput = { title: trimmed };

    if (when !== null) input.dueAt = endOfDay(when);
    if (high) input.manualPriority = 'high';

    setBusy(true);
    setError(null);

    try {
      await createTask(input);
      setTitle('');
      setWhen(null);
      setHigh(false);
      onAdded();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not add that task');
    } finally {
      setBusy(false);
    }
  }

  const chip = (selected: boolean) => [styles.chip, selected && styles.chipOn];
  const chipText = (selected: boolean) => [styles.chipText, selected && styles.chipTextOn];

  return (
    <View style={styles.wrap}>
      <View style={styles.inputRow}>
        <TextInput
          accessibilityLabel="New task"
          editable={!busy}
          onChangeText={setTitle}
          onSubmitEditing={() => {
            void submit();
          }}
          placeholder="Add a task…"
          placeholderTextColor={colors.textMuted}
          returnKeyType="done"
          style={styles.input}
          value={title}
        />
        <Pressable
          accessibilityLabel="Add task"
          accessibilityRole="button"
          disabled={busy || title.trim() === ''}
          onPress={() => {
            void submit();
          }}
          style={[styles.add, title.trim() === '' && styles.addOff]}
          testID="quick-add-submit"
        >
          <Ionicons name="arrow-up" size={20} color={colors.onAccent} />
        </Pressable>
      </View>

      <View style={styles.options}>
        {(['today', 'tomorrow'] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected: when === value }}
            onPress={() => {
              setWhen(when === value ? null : value);
            }}
            style={chip(when === value)}
            testID={`quick-add-${value}`}
          >
            <Text style={chipText(when === value)}>{value === 'today' ? 'Today' : 'Tomorrow'}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: high }}
          onPress={() => {
            setHigh(!high);
          }}
          style={chip(high)}
          testID="quick-add-high"
        >
          <Ionicons name="flag" size={12} color={high ? colors.onAccent : colors.textMuted} />
          <Text style={chipText(high)}>High</Text>
        </Pressable>
      </View>

      {error === null ? null : (
        <Text style={styles.error} testID="quick-add-error">
          {error}
        </Text>
      )}
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { gap: space.sm },
    inputRow: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
    input: {
      ...typeScale.body,
      backgroundColor: colors.surfaceMuted,
      borderRadius: radius.pill,
      color: colors.text,
      flex: 1,
      minHeight: TAP,
      paddingHorizontal: space.lg,
    },
    add: {
      alignItems: 'center',
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
      height: TAP,
      justifyContent: 'center',
      width: TAP,
    },
    addOff: { opacity: 0.4 },
    options: { flexDirection: 'row', gap: space.sm },
    chip: {
      alignItems: 'center',
      borderColor: colors.border,
      borderRadius: radius.pill,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 4,
      minHeight: TAP - 12,
      paddingHorizontal: space.md,
    },
    chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { ...typeScale.label, color: colors.textMuted },
    chipTextOn: { color: colors.onAccent },
    error: { ...typeScale.small, color: colors.danger },
  });
}
