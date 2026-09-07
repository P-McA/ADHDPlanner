import { describe, expect, it } from 'vitest';

import { TASK_PRIORITIES, TASK_STATUSES, type TaskStatus } from './task.js';

describe('task contract', () => {
  it('exposes the Phase 0 status set', () => {
    expect([...TASK_STATUSES]).toEqual(['pending', 'in_progress', 'done', 'archived']);
  });

  it('exposes the Phase 0 priority set', () => {
    expect([...TASK_PRIORITIES]).toEqual(['low', 'med', 'high', 'urgent']);
  });

  it('narrows a literal to TaskStatus', () => {
    const status: TaskStatus = 'in_progress';
    expect(TASK_STATUSES).toContain(status);
  });
});
