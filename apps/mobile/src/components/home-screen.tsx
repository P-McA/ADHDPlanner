import {
  type EarnedBadge,
  isTaskDraft,
  type RankedTask,
  type Task,
  type UserStats,
} from '@adhd/shared';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  ApiError,
  approveTask,
  completeTask,
  getBadges,
  getStats,
  listDrafts,
  listNext,
  predictTasks,
  rejectTask,
} from '../lib/api-client';
import { radius, space, TAP, type ThemeColors, type as typeScale, useTheme } from '../theme/theme';
import { MemoUpload } from './memo-upload';
import { QuickAdd } from './quick-add';
import { StatsHeader } from './stats-header';
import { TaskEstimate } from './task-estimate';
import { TaskList } from './task-list';
import { TaskSteps } from './task-steps';
import { VoiceRecorder } from './voice-recorder';

/**
 * The whole app: stats, tasks, suggestions, and one upload button.
 *
 * It loads through `listDrafts()` — `GET /tasks?include=drafts` — and splits
 * the page here, rather than making two round trips. The API hides unconfirmed
 * drafts by default, so a screen that wants both surfaces has to opt in once;
 * asking twice would also make the two lists disagree whenever a draft was
 * approved between the calls.
 *
 * Stats are refetched after a completion rather than adjusted locally. XP is a
 * ledger the server owns, and a client that adds 10 and guesses at the streak
 * will be wrong at the first day boundary, the first draft, and the first
 * double-tap.
 */
export function HomeScreen() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [badges, setBadges] = useState<EarnedBadge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // How Tasks is ordered: the computed "Next up" (default), or the plain list.
  const [order, setOrder] = useState<'next' | 'due'>('next');
  const [ranked, setRanked] = useState<RankedTask[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // Said after a "Suggest tasks" press that found nothing, so the press is not silent.
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const load = useCallback(async () => {
    setRefreshing(true);

    try {
      // Badges load with the stats, so the refresh after a completion or an
      // "Add to tasks" shows any badge it just earned.
      // "Next up" is its own request: the API computes the order on the
      // user's calendar. A reload starts it again from the top.
      const [page, nextPage, next, earned] = await Promise.all([
        listDrafts(),
        listNext(),
        getStats(),
        getBadges(),
      ]);

      setTasks(page.items);
      setRanked(nextPage.items);
      setNextCursor(nextPage.nextCursor);
      setStats(next);
      setBadges(earned);
      setError(null);
    } catch (cause) {
      // A named failure, not an empty list. "Cannot reach the API" and "you
      // have no tasks" look identical on screen otherwise, and the first one
      // is the one a phone hits constantly.
      setError(cause instanceof ApiError ? cause.message : 'Something went wrong');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function complete(id: string) {
    setBusyId(id);

    try {
      await completeTask(id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not complete that');
    } finally {
      setBusyId(null);
    }
  }

  async function approve(id: string) {
    setBusyId(id);

    try {
      // Reloaded, not moved locally: the approved task leaves Suggestions and
      // joins Tasks, and the review XP lands in the stats header — both the
      // server's to say.
      await approveTask(id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not add that to your tasks');
    } finally {
      setBusyId(null);
    }
  }

  async function suggest() {
    try {
      const created = await predictTasks();

      setSuggestNote(
        created.length === 0
          ? 'Nothing to suggest yet — this learns from what you finish, so check back later.'
          : null,
      );
      // Reloaded, not added locally: the drafts belong under Suggestions, and
      // which list a task sits in is the server's to say.
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not suggest tasks');
    }
  }

  async function loadMore() {
    if (nextCursor === null) return;

    try {
      const more = await listNext({ cursor: nextCursor });

      setRanked((current) => [...current, ...more.items]);
      setNextCursor(more.nextCursor);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load more');
    }
  }

  async function reject(id: string) {
    setBusyId(id);

    try {
      // Reloaded, like approve: the suggestion leaves the list on the server's
      // say-so, and the review XP lands in the header.
      await rejectTask(id);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not reject that');
    } finally {
      setBusyId(null);
    }
  }

  const drafts = tasks.filter(isTaskDraft);
  const confirmed = tasks.filter((task) => !isTaskDraft(task));
  const finished = confirmed.filter((task) => task.status === 'done');
  // Open tasks only: finished ones wait behind "Done (n)", out of the way of
  // what is left to do.
  const open = order === 'next' ? ranked : confirmed.filter((task) => task.status !== 'done');
  const reasonsById = new Map(ranked.map((task) => [task.id, task.rank.reasons]));

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.accent}
          onRefresh={() => {
            void load();
          }}
        />
      }
    >
      <StatsHeader stats={stats} badges={badges} />

      {error === null ? null : (
        <View style={styles.errorBox}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
          <Text style={styles.error} testID="error">
            {error}
          </Text>
        </View>
      )}

      <View style={styles.card}>
        <QuickAdd
          onAdded={() => {
            void load();
          }}
        />
        <View style={styles.divider} />
        <VoiceRecorder
          onUploaded={() => {
            void load();
          }}
        />
        <MemoUpload
          onUploaded={() => {
            void load();
          }}
        />
      </View>

      <View style={[styles.card, styles.suggestions]}>
        <View style={styles.sectionHeader}>
          <View style={styles.headingRow}>
            <Ionicons name="sparkles-outline" size={18} color={colors.draft} />
            <Text style={styles.heading} testID="suggestions-heading">
              Suggestions ({drafts.length})
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => {
              void suggest();
            }}
            style={styles.suggestButton}
            testID="suggest-tasks"
          >
            <Text style={styles.suggestText}>Suggest tasks</Text>
          </Pressable>
        </View>
        <Text style={styles.note}>
          From your memos and your history. Nothing here is a task until you add it.
        </Text>
        {suggestNote === null ? null : (
          <Text style={styles.note} testID="suggest-note">
            {suggestNote}
          </Text>
        )}
        {drafts.length === 0 ? null : (
          <TaskList
            tasks={drafts}
            busyId={busyId}
            onComplete={(id) => {
              void complete(id);
            }}
            onApprove={(id) => {
              void approve(id);
            }}
            onReject={(id) => {
              void reject(id);
            }}
          />
        )}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.heading}>Tasks</Text>
          <View style={styles.orderRow}>
            {(['next', 'due'] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected: order === value }}
                onPress={() => {
                  setOrder(value);
                }}
                style={[styles.orderChip, order === value ? styles.orderChipOn : null]}
                testID={`order-${value}`}
              >
                <Text style={order === value ? styles.orderTextOn : styles.orderText}>
                  {value === 'next' ? 'Next up' : 'Due date'}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <TaskList
          tasks={open}
          busyId={busyId}
          focusFirst={order === 'next'}
          onComplete={(id) => {
            void complete(id);
          }}
          // Only an open task: a finished one has nothing left to start, and
          // the API refuses to break one down or estimate it (409).
          renderDetail={(task) =>
            task.status === 'done' ? null : (
              <View style={styles.detail}>
                {order === 'next' && (reasonsById.get(task.id)?.length ?? 0) > 0 ? (
                  <Text style={styles.reasons} testID={`rank-reasons-${task.id}`}>
                    {reasonsById.get(task.id)?.join(' · ')}
                  </Text>
                ) : null}
                <View style={styles.chips}>
                  <TaskEstimate
                    task={task}
                    onChanged={() => {
                      void load();
                    }}
                  />
                  <TaskSteps
                    taskId={task.id}
                    onChanged={() => {
                      void load();
                    }}
                  />
                </View>
              </View>
            )
          }
        />
        {order === 'next' && nextCursor !== null ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void loadMore();
            }}
            style={styles.more}
            testID="show-more"
          >
            <Text style={styles.moreText}>Show more</Text>
          </Pressable>
        ) : null}

        {finished.length === 0 ? null : (
          <View style={styles.doneSection}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showDone }}
              onPress={() => {
                setShowDone(!showDone);
              }}
              style={styles.doneToggle}
              testID="done-toggle"
            >
              <Ionicons
                name={showDone ? 'chevron-down' : 'chevron-forward'}
                size={16}
                color={colors.textMuted}
              />
              <Text style={styles.doneText}>Done ({finished.length})</Text>
            </Pressable>
            {showDone ? (
              <TaskList
                tasks={finished}
                busyId={busyId}
                onComplete={(id) => {
                  void complete(id);
                }}
              />
            ) : null}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { backgroundColor: colors.background },
    content: {
      gap: space.xl,
      padding: space.lg,
      paddingBottom: space.xxl * 2,
      paddingTop: space.xxl,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.lg,
      borderWidth: 1,
      gap: space.md,
      padding: space.lg,
    },
    suggestions: { backgroundColor: colors.draftSoft, borderColor: colors.draftSoft },
    divider: { backgroundColor: colors.border, height: 1 },
    section: { gap: space.md },
    sectionHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    headingRow: { alignItems: 'center', flexDirection: 'row', gap: space.sm },
    heading: { ...typeScale.heading, color: colors.text },
    note: { ...typeScale.small, color: colors.textMuted },
    suggestButton: {
      backgroundColor: colors.surface,
      borderRadius: radius.pill,
      justifyContent: 'center',
      minHeight: TAP - 12,
      paddingHorizontal: space.md,
    },
    suggestText: { ...typeScale.label, color: colors.draft },
    orderRow: {
      backgroundColor: colors.surfaceMuted,
      borderRadius: radius.pill,
      flexDirection: 'row',
      padding: 3,
    },
    orderChip: {
      borderRadius: radius.pill,
      justifyContent: 'center',
      minHeight: TAP - 14,
      paddingHorizontal: space.md,
    },
    orderChipOn: { backgroundColor: colors.surface },
    orderText: { ...typeScale.label, color: colors.textMuted },
    orderTextOn: { ...typeScale.label, color: colors.text },
    detail: { gap: space.sm, paddingLeft: TAP - 12 + space.md },
    chips: { alignItems: 'flex-start', flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    reasons: { ...typeScale.small, color: colors.textMuted },
    more: { alignItems: 'center', justifyContent: 'center', minHeight: TAP },
    moreText: { ...typeScale.label, color: colors.accent },
    doneSection: { gap: space.sm },
    doneToggle: { alignItems: 'center', flexDirection: 'row', gap: space.xs, minHeight: TAP },
    doneText: { ...typeScale.label, color: colors.textMuted },
    errorBox: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.danger,
      borderRadius: radius.md,
      borderWidth: 1,
      flexDirection: 'row',
      gap: space.sm,
      padding: space.md,
    },
    error: { ...typeScale.small, color: colors.danger, flex: 1 },
  });
}
