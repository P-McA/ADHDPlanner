'use client';

import { isTaskDraft, type Task } from '@adhd/shared';
import { useCallback, useState } from 'react';

import {
  ApiError,
  approveTask,
  breakIntoSteps,
  deleteTask,
  listSteps,
  rejectTask,
  updateTask,
} from '../lib/api-client';
import { TaskRow } from './task-row';

/**
 * "Break this into steps", under one task.
 *
 * Collapsed until opened, and only then does it ask for the task's steps: the
 * dashboard has one of these per open task, and loading eagerly would be a
 * request per row on every refresh.
 *
 * What the model proposes arrives as suggestions, never as steps: each one is
 * approved or rejected by hand through the same routes as any other
 * suggestion. Nothing here confirms on the user's behalf.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setSteps(await listSteps(taskId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the steps');
    }
  }, [taskId]);

  const breakDown = async (): Promise<void> => {
    setThinking(true);
    setError(null);

    try {
      await breakIntoSteps(taskId);
      await load();
    } catch (caught) {
      // The API's own sentence: a 502 names what the model said, a 409 names
      // why the task cannot be broken down. Both are things the user can act on.
      setError(caught instanceof ApiError ? caught.message : 'Could not break that task down');
    } finally {
      setThinking(false);
    }
  };

  /** One write on a step, then the steps and the dashboard (XP, badges) reload. */
  const mutate = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);

    try {
      await action();
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const waiting = steps?.some(isTaskDraft) ?? false;

  return (
    <div className="task-steps">
      <button
        type="button"
        className="link-button"
        aria-expanded={open}
        onClick={() => {
          const next = !open;

          setOpen(next);
          if (next) void load();
        }}
      >
        {open ? 'Hide steps' : 'Steps'}
      </button>

      {open && (
        <div className="task-steps-body">
          {steps !== null && steps.length > 0 && (
            <ul className="task-list">
              {steps.map((step) => (
                <TaskRow
                  key={step.id}
                  task={step}
                  busy={busy}
                  onToggleComplete={(target) => {
                    void mutate(() =>
                      updateTask(target.id, {
                        status: target.status === 'done' ? 'pending' : 'done',
                      }),
                    );
                  }}
                  onRenameTitle={(target, title) => {
                    void mutate(() => updateTask(target.id, { title }));
                  }}
                  onApprove={(target) => {
                    void mutate(() => approveTask(target.id));
                  }}
                  onReject={(target) => {
                    void mutate(() => rejectTask(target.id));
                  }}
                  onDelete={(target) => {
                    void mutate(() => deleteTask(target.id));
                  }}
                />
              ))}
            </ul>
          )}

          {steps !== null && !waiting && (
            <button
              type="button"
              className="primary"
              disabled={thinking}
              onClick={() => {
                void breakDown();
              }}
            >
              {thinking ? 'Thinking…' : 'Break into steps'}
            </button>
          )}

          {error !== null && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
