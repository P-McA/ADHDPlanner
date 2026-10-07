import { isTaskDraft, type Task, type UserStats } from '@adhd/shared';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ApiError, completeTask, getStats, listDrafts } from '../lib/api-client';
import { MemoUpload } from './memo-upload';
import { VoiceRecorder } from './voice-recorder';
import { StatsHeader } from './stats-header';
import { TaskList } from './task-list';

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
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);

    try {
      const [page, next] = await Promise.all([listDrafts(), getStats()]);

      setTasks(page.items);
      setStats(next);
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

  const drafts = tasks.filter(isTaskDraft);
  const live = tasks.filter((task) => !isTaskDraft(task));

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
      <StatsHeader stats={stats} />

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
        <TaskList
          tasks={live}
          busyId={busyId}
          onComplete={(id) => {
            void complete(id);
          }}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.heading} testID="suggestions-heading">
          Suggestions ({drafts.length})
        </Text>
        <Text style={styles.note}>
          From your memos. Approve them on the web app before they count.
        </Text>
        <TaskList
          tasks={drafts}
          busyId={busyId}
          onComplete={(id) => {
            void complete(id);
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
});
