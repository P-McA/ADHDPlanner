import { isTaskDraft, type Task } from '@adhd/shared';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  ApiError,
  approveTask,
  breakIntoSteps,
  completeTask,
  listSteps,
  rejectTask,
} from '../lib/api-client';
import { TaskList } from './task-list';

/**
 * "Break this into steps", under one task.
 *
 * Collapsed until tapped, and only then does it ask for the task's steps: the
 * home screen has one of these per open task, and loading eagerly would be a
 * request per row on every refresh.
 *
 * What the model proposes arrives as suggestions, never as steps: each one is
 * added or rejected by hand through the same approve/reject routes as any
 * other suggestion. Nothing here confirms on the user's behalf.
 *
 * The breakdown button only shows when no suggestions are waiting. The API
 * refuses a second breakdown with unreviewed steps (409) — a second press
 * would pay the model again for the same thing — and a button that can only
 * fail is worse than no button.
 */
export function TaskSteps({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<Task[] | null>(null);
  const [thinking, setThinking] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSteps(await listSteps(taskId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load the steps');
    }
  }, [taskId]);

  function toggle() {
    const next = !open;

    setOpen(next);
    if (next) void load();
  }

  async function breakDown() {
    setThinking(true);
    setError(null);

    try {
      await breakIntoSteps(taskId);
      await load();
    } catch (cause) {
      // The API's own sentence: a 502 names what the model said, a 409 names
      // why the task cannot be broken down. Both are things the user can act on.
      setError(cause instanceof ApiError ? cause.message : 'Could not break that task down');
    } finally {
      setThinking(false);
    }
  }

  /** One write on a step, then the step list and the screen (XP, badges) reload. */
  async function act(id: string, write: (id: string) => Promise<Task>, failure: string) {
    setBusyId(id);

    try {
      await write(id);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : failure);
    } finally {
      setBusyId(null);
    }
  }

  const waiting = steps?.some(isTaskDraft) ?? false;

  return (
    <View style={styles.panel}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        testID={`steps-toggle-${taskId}`}
      >
        <Text style={styles.toggle}>{open ? 'Hide steps' : 'Steps'}</Text>
      </Pressable>

      {open ? (
        <View style={styles.body}>
          {steps === null || steps.length === 0 ? null : (
            <TaskList
              tasks={steps}
              busyId={busyId}
              onComplete={(id) => {
                void act(id, completeTask, 'Could not complete that step');
              }}
              onApprove={(id) => {
                void act(id, approveTask, 'Could not add that step');
              }}
              onReject={(id) => {
                void act(id, rejectTask, 'Could not reject that step');
              }}
            />
          )}

          {steps === null || waiting ? null : (
            <Pressable
              accessibilityRole="button"
              disabled={thinking}
              onPress={() => {
                void breakDown();
              }}
              style={styles.button}
              testID={`break-${taskId}`}
            >
              <Text style={styles.buttonText}>
                {thinking ? 'Thinking…' : 'Break into steps'}
              </Text>
            </Pressable>
          )}

          {error === null ? null : (
            <Text style={styles.error} testID={`steps-error-${taskId}`}>
              {error}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { paddingBottom: 8 },
  toggle: { color: '#7c3aed', fontSize: 13, fontWeight: '600' },
  body: { gap: 8, paddingLeft: 16, paddingTop: 4 },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: '#7c3aed',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  buttonText: { color: '#fff', fontWeight: '600' },
  error: { color: '#b91c1c', fontSize: 13 },
});
