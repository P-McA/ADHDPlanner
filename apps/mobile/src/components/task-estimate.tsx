import { ESTIMATE_BUCKETS, formatEstimate, type EstimateMinutes, type Task } from '@adhd/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { acceptEstimate, ApiError, dismissEstimate, suggestEstimate } from '../lib/api-client';

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
    <View style={styles.wrap}>
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
                style={styles.chip}
                testID={`estimate-bucket-${task.id}-${String(minutes)}`}
              >
                <Text style={styles.chipText}>{formatEstimate(minutes)}</Text>
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
          testID={`estimate-${task.id}`}
        >
          <Text style={styles.link}>{busy ? 'Estimating…' : 'Estimate'}</Text>
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

const styles = StyleSheet.create({
  wrap: { gap: 4, paddingBottom: 4 },
  suggestion: { gap: 6 },
  row: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  suggested: { color: '#7c3aed', fontSize: 13, fontWeight: '600' },
  estimate: { color: '#444', fontSize: 13, fontWeight: '600' },
  link: { color: '#7c3aed', fontSize: 13, fontWeight: '600' },
  note: { color: '#666', fontSize: 12 },
  button: {
    backgroundColor: '#fff',
    borderColor: '#ccc',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  primary: { backgroundColor: '#7c3aed', borderColor: '#7c3aed' },
  buttonText: { color: '#444', fontWeight: '600' },
  primaryText: { color: '#fff', fontWeight: '600' },
  chip: { borderColor: '#ddd', borderRadius: 12, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { color: '#444', fontSize: 12 },
  error: { color: '#b91c1c', fontSize: 13 },
});
