'use client';

import type { CreateTaskInput, TaskPriority } from '@adhd/shared';
import { TASK_PRIORITIES, TASK_TITLE_MAX_LENGTH } from '@adhd/shared';
import { useState } from 'react';

/**
 * Title, optional due date, priority.
 *
 * Everything created here is `source: 'manual'` by omission — the API defaults
 * it. Nothing in this UI may create an AI-sourced task, which is the
 * human-in-the-loop fence: drafts arrive from capture flows and are confirmed,
 * never minted by the task form.
 */
export function CreateTaskForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (input: CreateTaskInput) => void;
}) {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('med');

  const trimmed = title.trim();

  return (
    <form
      className="create-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed.length === 0) return;

        onCreate({
          title: trimmed,
          manualPriority: priority,
          // A date input gives a calendar day; the contract wants an instant.
          ...(dueDate === '' ? {} : { dueAt: new Date(`${dueDate}T00:00:00`).toISOString() }),
        });

        setTitle('');
        setDueDate('');
        setPriority('med');
      }}
    >
      <input
        type="text"
        value={title}
        placeholder="Add a task…"
        aria-label="Task title"
        maxLength={TASK_TITLE_MAX_LENGTH}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />

      <input
        type="date"
        value={dueDate}
        aria-label="Due date"
        onChange={(event) => {
          setDueDate(event.target.value);
        }}
      />

      <select
        value={priority}
        aria-label="Priority"
        onChange={(event) => {
          setPriority(event.target.value as TaskPriority);
        }}
      >
        {TASK_PRIORITIES.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>

      <button type="submit" className="primary" disabled={busy || trimmed.length === 0}>
        Add
      </button>
    </form>
  );
}
