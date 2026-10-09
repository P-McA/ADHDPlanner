'use client';

import { ESTIMATE_BUCKETS, formatEstimate, isEstimateMinutes, type Task } from '@adhd/shared';
import { useState } from 'react';

import { acceptEstimate, ApiError, dismissEstimate, suggestEstimate } from '../lib/api-client';

/**
 * "How long will this take?", under one task.
 *
 * Three states, all read off the task the dashboard already has, so this asks
 * the API nothing until a button is pressed:
 * - the user has an estimate: show it ("~30 min").
 * - the model has suggested one: show it *as a suggestion*, with Accept, a
 *   picker to correct it, and Dismiss. Nothing is accepted for the user.
 * - neither: an Estimate button.
 *
 * Every write ends in `onChanged`, because the dashboard owns the task list
 * and the stats header (reviewing pays XP), and both are the server's to say.
 */
export function TaskEstimate({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (write: () => Promise<Task>): Promise<void> => {
    setBusy(true);
    setError(null);

    try {
      await write();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const suggested = task.suggestedEstimateMinutes;

  return (
    <div className="task-estimate">
      {suggested !== null ? (
        <>
          <span className="estimate-suggested">Suggested {formatEstimate(suggested)}</span>
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => {
              void act(() => acceptEstimate(task.id));
            }}
          >
            Accept
          </button>
          {/* A correction is an accept with a different bucket: same route, same XP. */}
          <select
            aria-label="Use a different estimate"
            disabled={busy}
            value=""
            onChange={(event) => {
              const minutes = Number(event.target.value);

              if (isEstimateMinutes(minutes)) void act(() => acceptEstimate(task.id, minutes));
            }}
          >
            <option value="" disabled>
              Or…
            </option>
            {ESTIMATE_BUCKETS.filter((minutes) => minutes !== suggested).map((minutes) => (
              <option key={minutes} value={minutes}>
                {formatEstimate(minutes)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() => {
              void act(() => dismissEstimate(task.id));
            }}
          >
            Dismiss
          </button>
        </>
      ) : task.estimateMinutes !== null ? (
        <span className="badge">{formatEstimate(task.estimateMinutes)}</span>
      ) : (
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => {
            void act(() => suggestEstimate(task.id));
          }}
        >
          {busy ? 'Estimating…' : 'Estimate'}
        </button>
      )}

      {error !== null && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
