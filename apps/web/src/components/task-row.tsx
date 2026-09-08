'use client';

import type { Task } from '@adhd/shared';
import { isTaskDraft } from '@adhd/shared';
import { useState } from 'react';

/**
 * Whether to treat a task as an unconfirmed AI suggestion.
 *
 * Re-exported from `@adhd/shared` rather than defined here. It used to be a
 * local `source === 'ai_suggested'` check, which was wrong in one specific and
 * unpleasant way: a suggestion the user had already accepted kept its source
 * forever, so it kept its badge forever and stayed hidden behind the
 * suggestions toggle. `confirmedAt` is the other half, and the definition now
 * lives in one place so the API, the worker and this component cannot drift.
 */
export const isDraft = isTaskDraft;

/** Due dates render as a plain calendar date; the time of day is noise here. */
function formatDue(dueAt: string | null): string | null {
  if (dueAt === null) return null;

  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface TaskRowProps {
  task: Task;
  busy: boolean;
  onToggleComplete: (task: Task) => void;
  onRenameTitle: (task: Task, title: string) => void;
  onDelete: (task: Task) => void;
  /** Accept an AI suggestion. Only reachable while the task is still a draft. */
  onApprove: (task: Task) => void;
  /** Turn one down: archived, not deleted, so the suggestion is still on record. */
  onReject: (task: Task) => void;
}

export function TaskRow({
  task,
  busy,
  onToggleComplete,
  onRenameTitle,
  onDelete,
  onApprove,
  onReject,
}: TaskRowProps) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);

  const done = task.status === 'done';
  const due = formatDue(task.dueAt);

  const commit = (): void => {
    const trimmed = draftTitle.trim();
    setEditing(false);

    // An unchanged or empty title is not a rename; sending it would burn a
    // request and, when empty, fail the API's validation.
    if (trimmed.length > 0 && trimmed !== task.title) {
      onRenameTitle(task, trimmed);
    } else {
      setDraftTitle(task.title);
    }
  };

  const className = ['task', done ? 'is-done' : '', isDraft(task) ? 'is-draft' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <li className={className} data-testid="task">
      <input
        type="checkbox"
        checked={done}
        disabled={busy}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
        onChange={() => {
          onToggleComplete(task);
        }}
      />

      <div className="task-main">
        {editing ? (
          <input
            type="text"
            autoFocus
            value={draftTitle}
            aria-label={`Title for ${task.title}`}
            onChange={(event) => {
              setDraftTitle(event.target.value);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') {
                setDraftTitle(task.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="task-title">{task.title}</span>
        )}

        <div className="task-meta">
          {isDraft(task) && <span className="badge badge-draft">AI draft</span>}
          <span className={`priority-${task.manualPriority}`}>{task.manualPriority}</span>
          <span>{task.status}</span>
          {due !== null && <span>due {due}</span>}
        </div>
      </div>

      <div className="task-actions">
        {isDraft(task) && (
          <>
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => {
                onApprove(task);
              }}
            >
              Approve
            </button>
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => {
                onReject(task);
              }}
            >
              Reject
            </button>
          </>
        )}
        {!editing && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setDraftTitle(task.title);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          className="link-button danger"
          disabled={busy}
          onClick={() => {
            onDelete(task);
          }}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
