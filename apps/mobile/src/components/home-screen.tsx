import {
  type EarnedBadge,
  isTaskDraft,
  type RankedTask,
  type Task,
  type UserStats,
} from '@adhd/shared';
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
} from '../lib/api-client';
import { MemoUpload } from './memo-upload';
import { VoiceRecorder } from './voice-recorder';
import { StatsHeader } from './stats-header';
import { TaskEstimate } from './task-estimate';
import { TaskList } from './task-list';
import { TaskSteps } from './task-steps';

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

  const drafts = tasks.filter(isTaskDraft);
  const confirmed = tasks.filter((task) => !isTaskDraft(task));
  // In "Next up" the open tasks come ranked from the API; finished ones still
  // follow, from the plain list, so a completion does not vanish from view.
  const live =
    order === 'next'
      ? [...ranked, ...confirmed.filter((task) => task.status === 'done')]
      : confirmed;
  const reasonsById = new Map(ranked.map((task) => [task.id, task.rank.reasons]));

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            void load();
          }}
        />
      }
    >
      <StatsHeader stats={stats} badges={badges} />

      {error === null ? null : (
        <Text style={styles.error} testID="error">
          {error}
        </Text>
      )}

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

      <View style={styles.section}>
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
        <TaskList
          tasks={live}
          busyId={busyId}
          onComplete={(id) => {
            void complete(id);
          }}
          // Only an open task: a finished one has nothing left to start, and
          // the API refuses to break one down (409).
          renderDetail={(task) =>
            task.status === 'done' ? null : (
              <View>
                {order === 'next' && (reasonsById.get(task.id)?.length ?? 0) > 0 ? (
                  <Text style={styles.reasons} testID={`rank-reasons-${task.id}`}>
                    {reasonsById.get(task.id)?.join(' · ')}
                  </Text>
                ) : null}
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
            )
          }
        />
        {order === 'next' && nextCursor !== null ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              void loadMore();
            }}
            testID="show-more"
          >
            <Text style={styles.more}>Show more</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.heading} testID="suggestions-heading">
          Suggestions ({drafts.length})
        </Text>
        <Text style={styles.note}>From your memos. Nothing here is a task until you add it.</Text>
        <TaskList
          tasks={drafts}
          busyId={busyId}
          onComplete={(id) => {
            void complete(id);
          }}
          onApprove={(id) => {
            void approve(id);
          }}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: 20, padding: 16, paddingBottom: 48 },
  section: { gap: 4 },
  heading: { fontSize: 18, fontWeight: '700' },
  note: { color: '#666', fontSize: 13 },
  error: { color: '#b91c1c' },
  orderRow: { flexDirection: 'row', gap: 6, paddingBottom: 4 },
  orderChip: { borderColor: '#ddd', borderRadius: 12, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4 },
  orderChipOn: { backgroundColor: '#7c3aed', borderColor: '#7c3aed' },
  orderText: { color: '#444', fontSize: 13 },
  orderTextOn: { color: '#fff', fontSize: 13, fontWeight: '600' },
  reasons: { color: '#666', fontSize: 12 },
  more: { color: '#7c3aed', fontWeight: '600', paddingVertical: 8 },
});
