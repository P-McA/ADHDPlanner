import { formatEstimate, isTaskDraft, type Task } from '@adhd/shared';
import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { dueLabel, type DueTone } from '../lib/task-meta';
import { radius, space, TAP, type ThemeColors, type as typeScale, useTheme } from '../theme/theme';

/**
 * The task list, and its one write per row: tick a task done, or — for an AI
 * suggestion — add it to your tasks (or, where the screen allows, reject it).
 *
 * Each row says what matters for choosing it: when it is due, whether it is
 * high priority, and how long the user expects it to take. Nothing else.
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
  focusFirst = false,
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
   * screen passes it.
   */
  onReject?: (id: string) => void;
  /** Anything the screen wants under a row, such as estimate and steps. */
  renderDetail?: (task: Task) => ReactNode;
  busyId: string | null;
  /** Lift the first row into a "Next up" card — the one thing to start on. */
  focusFirst?: boolean;
}) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  if (tasks.length === 0) {
    return (
      <Text style={styles.empty} testID="empty">
        Nothing here.
      </Text>
    );
  }

  return (
    <View testID="task-list" style={styles.list}>
      {tasks.map((task, index) => {
        const draft = isTaskDraft(task);
        const done = task.status === 'done';
        const focus = focusFirst && index === 0 && !draft && !done;
        const due = done ? null : dueLabel(task.dueAt);
        const busy = busyId === task.id;

        return (
          <View key={task.id} style={[styles.item, focus && styles.focus, draft && styles.draftItem]}>
            {focus ? <Text style={styles.focusLabel}>NEXT UP</Text> : null}
            <View style={styles.row}>
              {draft ? null : done ? (
                <View style={styles.check} accessibilityLabel="Done">
                  <Ionicons name="checkmark-circle" size={28} color={colors.success} />
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Complete ${task.title}`}
                  disabled={busy}
                  hitSlop={8}
                  onPress={() => {
                    onComplete(task.id);
                  }}
                  style={styles.check}
                  testID={`complete-${task.id}`}
                >
                  <Ionicons
                    name={busy ? 'ellipsis-horizontal-circle-outline' : 'ellipse-outline'}
                    size={28}
                    color={focus ? colors.accent : colors.textMuted}
                  />
                </Pressable>
              )}

              <View style={styles.body}>
                <Text style={[styles.title, focus && styles.focusTitle, done && styles.doneTitle]}>
                  {task.title}
                </Text>

                <View style={styles.meta}>
                  {draft ? (
                    <View style={styles.badge} testID={`draft-badge-${task.id}`}>
                      <Ionicons name="sparkles-outline" size={12} color={colors.draft} />
                      <Text style={styles.badgeText}>AI suggestion</Text>
                    </View>
                  ) : null}
                  {due === null ? null : <Meta icon="calendar-outline" text={due.text} tone={due.tone} colors={colors} />}
                  {!done && (task.manualPriority === 'urgent' || task.manualPriority === 'high') ? (
                    <Meta
                      icon="flag"
                      text={task.manualPriority === 'urgent' ? 'Urgent' : 'High'}
                      tone="overdue"
                      colors={colors}
                    />
                  ) : null}
                  {task.estimateMinutes === null || done ? null : (
                    <Meta icon="time-outline" text={formatEstimate(task.estimateMinutes)} colors={colors} />
                  )}
                </View>

                {task.suggestionReason === null ? null : (
                  <Text style={styles.reason} testID={`suggestion-reason-${task.id}`}>
                    {task.suggestionReason}
                  </Text>
                )}
              </View>
            </View>

            {draft && !done ? (
              // A suggestion is approved, never completed: `done` on an
              // unconfirmed draft is a 409 from the API. Approving is the human
              // check the whole draft fence exists for, so it is a deliberate
              // tap here — nothing becomes a task on its own.
              <View style={styles.actions}>
                {onReject === undefined ? null : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Reject ${task.title}`}
                    disabled={busy}
                    onPress={() => {
                      onReject(task.id);
                    }}
                    style={[styles.button, styles.secondary]}
                    testID={`reject-${task.id}`}
                  >
                    <Ionicons name="close" size={16} color={colors.textMuted} />
                    <Text style={styles.secondaryText}>Reject</Text>
                  </Pressable>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${task.title} to tasks`}
                  disabled={busy || onApprove === undefined}
                  onPress={() => {
                    onApprove?.(task.id);
                  }}
                  style={[styles.button, styles.primary]}
                  testID={`approve-${task.id}`}
                >
                  <Ionicons name="add" size={16} color={colors.onAccent} />
                  <Text style={styles.primaryText}>{busy ? 'Adding…' : 'Add to tasks'}</Text>
                </Pressable>
              </View>
            ) : null}

            {renderDetail?.(task)}
          </View>
        );
      })}
    </View>
  );
}

function Meta({
  icon,
  text,
  tone,
  colors,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
  tone?: DueTone;
  colors: ThemeColors;
}) {
  const color =
    tone === 'overdue' ? colors.danger : tone === 'today' ? colors.warning : colors.textMuted;

  return (
    <View style={{ alignItems: 'center', flexDirection: 'row', gap: 3 }}>
      <Ionicons name={icon} size={13} color={color} />
      <Text style={[typeScale.small, { color }]}>{text}</Text>
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    list: { gap: space.sm },
    item: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.md,
      borderWidth: 1,
      gap: space.sm,
      padding: space.md,
    },
    focus: { borderColor: colors.accent, borderWidth: 2, padding: space.lg },
    focusLabel: { ...typeScale.caption, color: colors.accent },
    // Suggestions sit on a violet card, so each one is a plain surface on it;
    // the "AI suggestion" pill is what marks it.
    draftItem: { borderColor: colors.surface },
    row: { alignItems: 'flex-start', flexDirection: 'row', gap: space.md },
    check: { alignItems: 'center', height: TAP - 12, justifyContent: 'center', width: TAP - 12 },
    body: { flex: 1, gap: space.xs, paddingTop: 4 },
    title: { ...typeScale.body, color: colors.text },
    focusTitle: { fontSize: 19, fontWeight: '600' },
    doneTitle: { color: colors.textMuted, textDecorationLine: 'line-through' },
    meta: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
    badge: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: space.sm,
      paddingVertical: 2,
    },
    badgeText: { ...typeScale.caption, color: colors.draft },
    reason: { ...typeScale.small, color: colors.textMuted, fontStyle: 'italic' },
    actions: { flexDirection: 'row', gap: space.sm, justifyContent: 'flex-end' },
    button: {
      alignItems: 'center',
      borderRadius: radius.pill,
      flexDirection: 'row',
      gap: 4,
      minHeight: TAP - 8,
      paddingHorizontal: space.lg,
    },
    primary: { backgroundColor: colors.accent },
    primaryText: { ...typeScale.label, color: colors.onAccent },
    secondary: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
    secondaryText: { ...typeScale.label, color: colors.textMuted },
    empty: { ...typeScale.small, color: colors.textMuted, paddingVertical: space.lg, textAlign: 'center' },
  });
}
