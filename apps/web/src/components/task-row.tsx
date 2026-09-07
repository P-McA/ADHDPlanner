'use client';

import type { Task } from '@adhd/shared';
import { useState } from 'react';

/**
 * A task is an unconfirmed AI draft if it says so in its provenance.
 *
 * `ai_suggested` is the only source that means "proposed, not yet accepted".
 * The schema has no confirmed/draft flag of its own, so a voice- or
 * image-captured task keeps its source after the user accepts it and cannot be
 * told apart here — see the note in the README about what Phase 1.4 needs.
 */
export function isDraft(task: Task): boolean {
  return task.source === 'ai_suggested';
}

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
}

export function TaskRow({ task, busy, onToggleComplete, onRenameTitle, onDelete }: TaskRowProps) {
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
