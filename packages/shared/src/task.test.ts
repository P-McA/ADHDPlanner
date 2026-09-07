import { describe, expect, it } from 'vitest';

import { TASK_PRIORITIES, TASK_SOURCES, TASK_STATUSES, type TaskStatus } from './task.js';

describe('task contract', () => {
  it('exposes the status set', () => {
    expect([...TASK_STATUSES]).toEqual(['pending', 'in_progress', 'done', 'archived']);
  });

  it('exposes the priority set', () => {
    expect([...TASK_PRIORITIES]).toEqual(['low', 'med', 'high', 'urgent']);
  });

  // These must stay in lockstep with the TaskSource enum in
  // apps/api/prisma/schema.prisma — the DB rejects any value not listed there.
  it('exposes the source set in schema order', () => {
    expect([...TASK_SOURCES]).toEqual(['manual', 'voice', 'image', 'agent', 'ai_suggested']);
  });

  it('narrows a literal to TaskStatus', () => {
    const status: TaskStatus = 'in_progress';
    expect(TASK_STATUSES).toContain(status);
  });
});
