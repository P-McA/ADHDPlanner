import { isTaskDraft, type Task } from '@adhd/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * The task list, and the one write this shell offers: mark it done.
 *
 * The draft badge asks `isTaskDraft` from `@adhd/shared` rather than checking
 * `source` alone. That exact shortcut was a real bug in the web row — an
 * approved suggestion kept its badge for ever, because being AI-authored is
 * permanent and being *unconfirmed* is not. Draft-ness is the pair.
 */
export function TaskList({
  tasks,
  onComplete,
  busyId,
}: {
  tasks: Task[];
  onComplete: (id: string) => void;
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
          ) : (
            <Pressable
              accessibilityRole="button"
              // Completing an unconfirmed draft is a 409 from the API, not a
              // 404: the row exists and is the caller's, the state is what is
              // wrong. Hiding the button keeps the phone from asking, but the
              // fence is the server's — this is courtesy, not enforcement.
              disabled={busyId === task.id || isTaskDraft(task)}
              onPress={() => {
                onComplete(task.id);
              }}
              style={styles.button}
              testID={`complete-${task.id}`}
            >
              <Text style={styles.buttonText}>
                {busyId === task.id ? 'Saving…' : 'Done'}
              </Text>
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
  buttonText: { color: '#fff', fontWeight: '600' },
  done: { color: '#16a34a', fontWeight: '600' },
  empty: { color: '#666', paddingVertical: 16 },
});
