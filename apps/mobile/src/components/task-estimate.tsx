import { ESTIMATE_BUCKETS, formatEstimate, type EstimateMinutes, type Task } from '@adhd/shared';
import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { acceptEstimate, ApiError, dismissEstimate, suggestEstimate } from '../lib/api-client';
import { radius, space, TAP, type ThemeColors, type as typeScale, useTheme } from '../theme/theme';

/**
 * "How long will this take?", under one task.
 *
 * Three states, all read off the task the screen already has, so this asks
 * the API nothing until a button is pressed:
 * - the user has an estimate: show it ("~30 min").
 * - the model has suggested one: show it *as a suggestion*, with Accept, the
 *   buckets to correct it to, and Dismiss. Nothing is accepted for the user.
 * - neither: an Estimate button.
 *
 * Every write ends in `onChanged`, because the screen owns the task list and
 * the stats header (reviewing pays XP), and both are the server's to say.
 */
export function TaskEstimate({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(write: () => Promise<Task>, failure: string) {
    setBusy(true);
    setError(null);

    try {
      await write();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : failure);
    } finally {
      setBusy(false);
    }
  }

  const suggested = task.suggestedEstimateMinutes;

  return (
    <View style={[styles.wrap, suggested !== null && styles.wide]}>
      {suggested !== null ? (
        <View style={styles.suggestion}>
          <Text style={styles.suggested} testID={`suggested-estimate-${task.id}`}>
            Suggested {formatEstimate(suggested)}
          </Text>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Accept ${formatEstimate(suggested)}`}
              disabled={busy}
              onPress={() => {
                void act(() => acceptEstimate(task.id, undefined), 'Could not accept that estimate');
              }}
              style={[styles.button, styles.primary]}
              testID={`accept-estimate-${task.id}`}
            >
              <Text style={styles.primaryText}>Accept</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                void act(() => dismissEstimate(task.id), 'Could not dismiss that estimate');
              }}
              style={styles.button}
              testID={`dismiss-estimate-${task.id}`}
            >
              <Text style={styles.buttonText}>Dismiss</Text>
            </Pressable>
          </View>
          {/* A correction is an accept with a different bucket: same route, same XP. */}
          <View style={styles.row}>
            <Text style={styles.note}>Or:</Text>
            {ESTIMATE_BUCKETS.filter((minutes) => minutes !== suggested).map((minutes: EstimateMinutes) => (
              <Pressable
                key={minutes}
                accessibilityRole="button"
                accessibilityLabel={`Use ${formatEstimate(minutes)} instead`}
                disabled={busy}
                onPress={() => {
                  void act(() => acceptEstimate(task.id, minutes), 'Could not save that estimate');
                }}
                style={styles.bucket}
                testID={`estimate-bucket-${task.id}-${String(minutes)}`}
              >
                <Text style={styles.bucketText}>{formatEstimate(minutes)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : task.estimateMinutes !== null ? (
        <Text style={styles.estimate} testID={`estimate-label-${task.id}`}>
          {formatEstimate(task.estimateMinutes)}
        </Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            void act(() => suggestEstimate(task.id), 'Could not estimate that task');
          }}
          style={styles.chip}
          testID={`estimate-${task.id}`}
        >
          <Ionicons name="time-outline" size={14} color={colors.accent} />
          <Text style={styles.chipText}>{busy ? 'Estimating…' : 'Estimate'}</Text>
        </Pressable>
      )}

      {error === null ? null : (
        <Text style={styles.error} testID={`estimate-error-${task.id}`}>
          {error}
        </Text>
      )}
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  const chip = {
    alignItems: 'center' as const,
    borderRadius: radius.pill,
    flexDirection: 'row' as const,
    gap: 4,
    minHeight: TAP - 12,
    paddingHorizontal: space.md,
  };

  return StyleSheet.create({
    wrap: { gap: space.xs },
    // A waiting suggestion needs the room for its buttons: its own line.
    wide: { width: '100%' },
    suggestion: {
      backgroundColor: colors.draftSoft,
      borderRadius: radius.md,
      gap: space.sm,
      padding: space.md,
    },
    row: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    suggested: { ...typeScale.label, color: colors.draft },
    estimate: { ...typeScale.label, color: colors.textMuted },
    chip: { ...chip, alignSelf: 'flex-start', backgroundColor: colors.accentSoft },
    chipText: { ...typeScale.label, color: colors.accent },
    note: { ...typeScale.small, color: colors.textMuted },
    button: {
      ...chip,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      paddingHorizontal: space.lg,
    },
    primary: { backgroundColor: colors.accent, borderColor: colors.accent },
    buttonText: { ...typeScale.label, color: colors.textMuted },
    primaryText: { ...typeScale.label, color: colors.onAccent },
    // The correction buckets: small, but each still a comfortable tap.
    bucket: {
      ...chip,
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: 1,
      paddingHorizontal: space.sm,
    },
    bucketText: { ...typeScale.small, color: colors.text },
    error: { ...typeScale.small, color: colors.danger },
  });
}
