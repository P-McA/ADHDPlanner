/**
 * Phase 0 task contract.
 *
 * Deliberately limited to fields the Phase 0 CRUD shell needs. Everything the
 * architecture doc lists under later phases — priority_score, loe_minutes,
 * loe_confidence, parent_task_id, source — is intentionally absent and should
 * be added by the phase that actually populates it.
 */

export const TASK_STATUSES = ['pending', 'in_progress', 'done', 'archived'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'med', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface Task {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  manualPriority: TaskPriority;
  /** ISO 8601 timestamp. Serialised as a string so the contract survives JSON transport. */
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields a client may supply when creating a task. */
export type CreateTaskInput = Pick<Task, 'title'> &
  Partial<Pick<Task, 'description' | 'manualPriority' | 'dueAt'>>;

/** Fields a client may change on an existing task. */
export type UpdateTaskInput = Partial<
  Pick<Task, 'title' | 'description' | 'status' | 'manualPriority' | 'dueAt'>
>;
