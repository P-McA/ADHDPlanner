/**
 * Phase 1 task contract.
 *
 * Carries the fields the MVP populates, including the two the capture and
 * breakdown flows need: `source` (provenance) and `parentTaskId`
 * (decomposition). The AI-derived scoring fields the architecture doc lists —
 * priority_score, loe_minutes, loe_confidence — remain absent until Phase 2
 * actually computes them.
 */

export const TASK_STATUSES = ['pending', 'in_progress', 'done', 'archived'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'med', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_SOURCES = ['manual', 'voice', 'image', 'agent', 'ai_suggested'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export interface Task {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  manualPriority: TaskPriority;
  /** How the task was captured. Defaults to 'manual'. */
  source: TaskSource;
  /** ISO 8601 timestamp. Serialised as a string so the contract survives JSON transport. */
  dueAt: string | null;
  completedAt: string | null;
  /** Parent task when this row is a generated subtask; null at the top level. */
  parentTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields a client may supply when creating a task. */
export type CreateTaskInput = Pick<Task, 'title'> &
  Partial<Pick<Task, 'description' | 'manualPriority' | 'dueAt' | 'source' | 'parentTaskId'>>;

/**
 * Fields a client may change on an existing task.
 *
 * `source` and `parentTaskId` are creation-time only: provenance should not be
 * rewritable after the fact, and allowing re-parenting would let clients build
 * cycles in the decomposition tree with no cheap way to detect them.
 */
export type UpdateTaskInput = Partial<
  Pick<Task, 'title' | 'description' | 'status' | 'manualPriority' | 'dueAt'>
>;
