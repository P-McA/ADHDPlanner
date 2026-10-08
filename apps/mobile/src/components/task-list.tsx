import { isTaskDraft, type Task } from '@adhd/shared';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * The task list, and its one write per row: mark a task done, or — for an AI
 * suggestion — add it to your tasks (or, where the screen allows, reject it).
 *
 * The draft badge asks `isTaskDraft` from `@adhd/shared` rather than checking
 * `source` alone. That exact shortcut was a real bug in the web row — an
 * approved suggestion kept its badge for ever, because being AI-authored is
 * permanent and being *unconfirmed* is not. Draft-ness is the pair.
 */
export function TaskList({
  tasks,
  onComplete,
  onApprove,
  onReject,
  renderDetail,
  busyId,
}: {
  tasks: Task[];
  onComplete: (id: string) => void;
  /**
   * Confirms a suggestion into a real task (`POST /tasks/:id/approve`). The
   * only way a draft stops being one: completing it directly is a 409 from
   * the API, which is why a draft's button approves rather than completes.
   */
  onApprove?: (id: string) => void;
  /**
   * Declines a suggestion (`POST /tasks/:id/reject`). Offered only where the
   * screen passes it — the steps panel does; Suggestions does not yet.
   */
  onReject?: (id: string) => void;
  /** Anything the screen wants under a row, such as the steps panel. */
  renderDetail?: (task: Task) => ReactNode;
  busyId: string | null;
}) {
  if (tasks.length === 0) {
    return (
      <Text style={styles.empty} testID="empty">
        Nothing here.
      </Text>
    );
  }

  return (
    <View testID="task-list">
      {tasks.map((task) => (
        <View key={task.id} style={styles.item}>
          <View style={styles.row}>
            <View style={styles.body}>
              <Text style={styles.title}>{task.title}</Text>
              {isTaskDraft(task) ? (
                <Text style={styles.badge} testID={`draft-badge-${task.id}`}>
                  AI suggestion
                </Text>
              ) : null}
            </View>

            {task.status === 'done' ? (
              <Text style={styles.done}>Done</Text>
            ) : isTaskDraft(task) ? (
              // A suggestion is approved, never completed: `done` on an
              // unconfirmed draft is a 409 from the API. Approving is the human
              // check the whole draft fence exists for, so it is a deliberate tap
              // here — nothing becomes a task on its own.
              <View style={styles.actions}>
                {onReject === undefined ? null : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Reject ${task.title}`}
                    disabled={busyId === task.id}
                    onPress={() => {
                      onReject(task.id);
                    }}
                    style={[styles.button, styles.reject]}
                    testID={`reject-${task.id}`}
                  >
                    <Text style={styles.rejectText}>Reject</Text>
                  </Pressable>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${task.title} to tasks`}
                  disabled={busyId === task.id || onApprove === undefined}
                  onPress={() => {
                    onApprove?.(task.id);
                  }}
                  style={[styles.button, styles.approve]}
                  testID={`approve-${task.id}`}
                >
                  <Text style={styles.buttonText}>
                    {busyId === task.id ? 'Adding…' : 'Add to tasks'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                accessibilityRole="button"
                disabled={busyId === task.id}
                onPress={() => {
                  onComplete(task.id);
                }}
                style={styles.button}
                testID={`complete-${task.id}`}
              >
                <Text style={styles.buttonText}>{busyId === task.id ? 'Saving…' : 'Done'}</Text>
              </Pressable>
            )}
          </View>

          {renderDetail?.(task)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { borderBottomColor: '#eee', borderBottomWidth: 1 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
  body: { flex: 1, gap: 4 },
  title: { fontSize: 16 },
  badge: { color: '#7c3aed', fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8 },
  button: { backgroundColor: '#111', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  approve: { backgroundColor: '#7c3aed' },
  reject: { backgroundColor: '#fff', borderColor: '#ccc', borderWidth: 1 },
  buttonText: { color: '#fff', fontWeight: '600' },
  rejectText: { color: '#444', fontWeight: '600' },
  done: { color: '#16a34a', fontWeight: '600' },
  empty: { color: '#666', paddingVertical: 16 },
});
