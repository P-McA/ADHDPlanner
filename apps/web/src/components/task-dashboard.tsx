'use client';

import type {
  ActivityMetrics,
  CreateTaskInput,
  EarnedBadge,
  RankedTask,
  Task,
  TrackingMode,
  UserStats,
} from '@adhd/shared';
import { isIanaTimeZone, TASK_LIST_MAX_LIMIT } from '@adhd/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  approveTask,
  createTask,
  deleteTask,
  devModeEnabled,
  getActivity,
  getBadges,
  getMe,
  getStats,
  listNext,
  listTasks,
  predictTasks,
  rejectTask,
  startTask,
  updateProfile,
  updateTask,
} from '../lib/api-client';
import { CreateTaskForm } from './create-task-form';
import { PhotoUpload } from './photo-upload';
import { StatsHeader } from './stats-header';
import { isDraft, TaskRow } from './task-row';
import { TaskEstimate } from './task-estimate';
import { TaskSteps } from './task-steps';

type Tab = 'open' | 'done';

/** How the open tab is ordered: the computed "Next up", or the plain due-date list. */
type Order = 'next' | 'due';

/**
 * Tasks and stats for the signed-in user.
 *
 * Refresh strategy after a completion: **refetch, not optimistic**. Completing
 * a task moves level, XP and both streak counters, and every one of those is
 * derived server-side — the level from the whole ledger, the streak from the
 * user's stored timezone. Guessing them here would mean reimplementing that
 * logic in the client and being subtly wrong across midnight in the user's
 * zone, which is exactly the bug the server-side day boundary exists to avoid.
 * One extra round trip is the cheaper trade.
 */
export function TaskDashboard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [badges, setBadges] = useState<EarnedBadge[]>([]);
  const [mode, setMode] = useState<TrackingMode>('metrics');
  const [showElo, setShowElo] = useState(false);
  const [activity, setActivity] = useState<ActivityMetrics | null>(null);
  // While a preference write is in flight, a refresh must not overwrite it.
  const pendingPref = useRef(0);
  const [tab, setTab] = useState<Tab>('open');
  const [order, setOrder] = useState<Order>('next');
  const [ranked, setRanked] = useState<RankedTask[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  // Said after a "Suggest tasks" press that found nothing, so the press is not silent.
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  // The zone already reported, so a refresh costs nothing unless it changed.
  const reportedZone = useRef<string | null>(null);

  /**
   * Tells the API which zone the browser is in.
   *
   * "Today" is decided on the server from the profile's zone (Next up, streaks,
   * reminders), so the two agree only if the profile holds the browser's zone.
   * Only a changed zone is sent, and a failed report is forgotten rather than
   * remembered, so the next refresh tries again.
   */
  const reportZone = useCallback((): void => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    if (typeof zone !== 'string' || !isIanaTimeZone(zone) || zone === reportedZone.current) return;

    reportedZone.current = zone;
    updateProfile({ timezone: zone }).catch(() => {
      if (reportedZone.current === zone) reportedZone.current = null;
    });
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      // One unfiltered page serves both tabs. The API's status filter takes a
      // single exact value, and "open" is pending + in_progress, which it
      // cannot express — so the split happens here. The ceiling is the API's
      // own max page size; paging is not part of this slice.
      // `include: 'drafts'` is required now that the API fences them out of the
      // default page. This view has somewhere to put them — the suggestions
      // toggle, which is the review surface — so it asks for them explicitly
      // and keeps them out of the ordinary lists itself.
      // Badges ride along with the stats so a completion that earns one shows
      // it on the same refresh — never computed locally, like everything else
      // in the header.
      // "Next up" is its own request: the order is computed by the API on the
      // user's calendar, and paged by cursor. A refresh starts it again from
      // the top, so the order shown is always the current one.
      const [page, nextPage, nextStats, nextBadges] = await Promise.all([
        listTasks({ limit: TASK_LIST_MAX_LIMIT, include: 'drafts' }),
        listNext(),
        getStats(),
        getBadges(),
      ]);
      // The header is decorative next to the list: a failed profile or activity
      // read degrades to dashes rather than blanking the screen.
      const [me, nextActivity] = await Promise.all([
        getMe().catch(() => null),
        getActivity().catch(() => null),
      ]);

      setTasks(page.items);
      setRanked(nextPage.items);
      setNextCursor(nextPage.nextCursor);
      setStats(nextStats);
      setBadges(nextBadges);
      if (me && pendingPref.current === 0) {
        setMode(me.trackingMode ?? 'metrics');
        setShowElo(me.showElo);
      }
      if (nextActivity) setActivity(nextActivity);
      setError(null);
      // Only after a successful authenticated read: an unauthenticated refresh
      // would otherwise report a zone the API cannot attribute to anyone.
      reportZone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, String(caught)));
    } finally {
      setLoading(false);
    }
  }, [reportZone]);

  useEffect(() => {
    // The rule guards against cascading renders from setState during an effect
    // body. Nothing here sets state synchronously: `refresh` awaits the network
    // first, and this is the load-on-mount fetch. A data-fetching library would
    // own this instead, but adding one needs sign-off under the dependency rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  /**
   * Display preferences are optimistic: the data does not change, so a full
   * refresh would only flicker. A failed write reverts the switch.
   */
  const changeMode = (next: TrackingMode): void => {
    const previous = mode;
    const token = ++pendingPref.current;
    setMode(next);
    updateProfile({ trackingMode: next })
      .catch(() => {
        if (token === pendingPref.current) setMode(previous);
      })
      .finally(() => {
        if (token === pendingPref.current) pendingPref.current = 0;
      });
  };

  const toggleElo = (): void => {
    const next = !showElo;
    const token = ++pendingPref.current;
    setShowElo(next);
    updateProfile({ showElo: next })
      .catch(() => {
        if (token === pendingPref.current) setShowElo(!next);
      })
      .finally(() => {
        if (token === pendingPref.current) pendingPref.current = 0;
      });
  };

  /** Runs a mutation, then resyncs both lists and stats from the server. */
  const mutate = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);

    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, String(caught)));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <p className="notice">Loading…</p>;
  }

  if (error?.isUnauthenticated === true) {
    return (
      <div className="notice">
        <h2>Not signed in</h2>
        <p>
          The API rejected this session. Sign in with Clerk, or set{' '}
          <code>NEXT_PUBLIC_DEV_MODE=true</code> here and <code>DEV_AUTH_BYPASS=true</code> on the
          API to work without Clerk keys.
        </p>
      </div>
    );
  }

  if (error !== null && tasks.length === 0) {
    return (
      <div className="notice error">
        <h2>Could not load your tasks</h2>
        <p>{error.message}</p>
      </div>
    );
  }

  // Drafts stay out of the ordinary lists entirely: an unconfirmed AI
  // suggestion must never sit in the day's work looking like a decision the
  // user already made.
  const drafts = tasks.filter(isDraft);
  const confirmed = tasks.filter((task) => !isDraft(task));

  // Drafts join the open list only. They are unconfirmed by definition, so
  // they have no business under "Done" — a suggestion nobody has agreed to
  // cannot be something the user finished.
  const showDrafts = showSuggestions && tab === 'open';

  const nextUp = tab === 'open' && order === 'next';
  // Why each open task is where it is, for the line under it in "Next up".
  const reasonsById = new Map(ranked.map((task) => [task.id, task.rank.reasons]));

  const visible = [
    ...(nextUp
      ? ranked
      : confirmed.filter((task) =>
          tab === 'done' ? task.status === 'done' : task.status !== 'done',
        )),
    ...(showDrafts ? drafts : []),
  ];

  /** Appends the next "Next up" page, from the cursor the API last gave. */
  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) return;

    try {
      const more = await listNext({ cursor: nextCursor });

      setRanked((current) => [...current, ...more.items]);
      setNextCursor(more.nextCursor);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, String(caught)));
    }
  };

  return (
    <>
      <StatsHeader
        mode={mode}
        showElo={showElo}
        stats={stats}
        activity={activity}
        badges={badges}
        onChangeMode={changeMode}
        onToggleElo={toggleElo}
      />

      <CreateTaskForm
        busy={busy}
        onCreate={(input: CreateTaskInput) => {
          void mutate(() => createTask(input));
        }}
      />

      <PhotoUpload
        onUploaded={() => {
          void refresh();
        }}
      />

      <div className="controls">
        {(['open', 'done'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="tab"
            aria-pressed={tab === value}
            onClick={() => {
              setTab(value);
            }}
          >
            {value === 'open' ? 'Open' : 'Done'}
          </button>
        ))}

        {tab === 'open' && (
          <label className="order-select">
            Order
            <select
              value={order}
              onChange={(event) => {
                setOrder(event.target.value === 'due' ? 'due' : 'next');
              }}
            >
              <option value="next">Next up</option>
              <option value="due">Due date</option>
            </select>
          </label>
        )}

        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => {
            void mutate(async () => {
              const created = await predictTasks();

              // Shown where they will be reviewed; nothing was approved by asking.
              setShowSuggestions(true);
              setSuggestNote(
                created.length === 0
                  ? 'Nothing to suggest yet — this learns from what you finish, so check back later.'
                  : null,
              );
            });
          }}
        >
          Suggest tasks
        </button>

        <label className="suggestions-toggle">
          <input
            type="checkbox"
            checked={showSuggestions}
            onChange={(event) => {
              setShowSuggestions(event.target.checked);
            }}
          />
          AI suggestions ({drafts.length})
        </label>
      </div>

      {error !== null && <p className="notice error">{error.message}</p>}
      {suggestNote !== null && <p className="notice">{suggestNote}</p>}

      {visible.length === 0 ? (
        <p className="notice">
          {tab === 'done' ? 'Nothing completed yet.' : 'Nothing open — add something above.'}
        </p>
      ) : (
        <ul className="task-list">
          {visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              busy={busy}
              onToggleComplete={(target) => {
                void mutate(() =>
                  updateTask(target.id, {
                    status: target.status === 'done' ? 'pending' : 'done',
                  }),
                );
              }}
              onStart={(target) => {
                void mutate(() => startTask(target.id));
              }}
              onRenameTitle={(target, title) => {
                void mutate(() => updateTask(target.id, { title }));
              }}
              onApprove={(target) => {
                // Refetch rather than patch locally: the approved task moves
                // out of the drafts list and into the open one, and the source
                // of truth for which side it belongs on is the server's
                // confirmedAt, not a guess made here.
                void mutate(() => approveTask(target.id));
              }}
              onReject={(target) => {
                void mutate(() => rejectTask(target.id));
              }}
              onDelete={(target) => {
                void mutate(() => deleteTask(target.id));
              }}
              // Only an open task the user owns: a suggestion has to be approved
              // first, and a finished task has nothing left to start — the API
              // refuses both (409).
              detail={
                isDraft(task) ? (
                  // Why a predicted draft was suggested; other drafts have no reason.
                  task.suggestionReason === null ? undefined : (
                    <p className="task-reason">{task.suggestionReason}</p>
                  )
                ) : task.status === 'done' ? undefined : (
                  <>
                    {nextUp && (reasonsById.get(task.id)?.length ?? 0) > 0 && (
                      <p className="task-reason">{reasonsById.get(task.id)?.join(' · ')}</p>
                    )}
                    <TaskEstimate
                      task={task}
                      onChanged={() => {
                        void refresh();
                      }}
                    />
                    <TaskSteps
                      taskId={task.id}
                      onChanged={() => {
                        void refresh();
                      }}
                    />
                  </>
                )
              }
            />
          ))}
        </ul>
      )}

      {nextUp && nextCursor !== null && (
        <button
          type="button"
          className="link-button"
          onClick={() => {
            void loadMore();
          }}
        >
          Show more
        </button>
      )}

      {devModeEnabled() && (
        <p className="dev-banner">
          Dev sign-in is on: requests carry <code>x-dev-user</code>. The API only honours it when it
          is itself started with <code>DEV_AUTH_BYPASS=true</code> outside production.
        </p>
      )}
    </>
  );
}
