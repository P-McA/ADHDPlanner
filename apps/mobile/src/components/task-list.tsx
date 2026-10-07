import { isTaskDraft, type Task } from '@adhd/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * The task list, and its one write per row: mark a task done, or — for an AI
 * suggestion — add it to your tasks.
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
        <View key={task.id} style={styles.row}>
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
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    borderBottomColor: '#eee',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
  body: { flex: 1, gap: 4 },
  title: { fontSize: 16 },
  badge: { color: '#7c3aed', fontSize: 12, fontWeight: '600' },
  button: { backgroundColor: '#111', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  approve: { backgroundColor: '#7c3aed' },
  buttonText: { color: '#fff', fontWeight: '600' },
  done: { color: '#16a34a', fontWeight: '600' },
  empty: { color: '#666', paddingVertical: 16 },
});
