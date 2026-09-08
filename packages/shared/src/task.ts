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
  /**
   * When the user accepted an AI-extracted task, or null if they have not.
   *
   * This is the human-in-the-loop fence made into data. It is deliberately
   * *not* "was this created by a human": a manually typed task is null here
   * too, because it was authored rather than confirmed. What makes a row a
   * draft is the pair — see `isTaskDraft`.
   */
  confirmedAt: string | null;
  /** Parent task when this row is a generated subtask; null at the top level. */
  parentTaskId: string | null;
  /** The voice memo this task was extracted from; null when not from capture. */
  ingestionRecordId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Whether a task is an unconfirmed AI suggestion.
 *
 * The single definition of the fence, shared so the API, the worker and the
 * web client cannot drift apart on what "draft" means. Both halves matter:
 * `source` alone would badge a suggestion forever, even after the user
 * accepted it, and `confirmedAt` alone would treat every hand-typed task as a
 * draft awaiting approval.
 */
export function isTaskDraft(task: Pick<Task, 'source' | 'confirmedAt'>): boolean {
  return task.source === 'ai_suggested' && task.confirmedAt === null;
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

/** Title bounds, shared so client-side validation matches the API's. */
export const TASK_TITLE_MIN_LENGTH = 1;
export const TASK_TITLE_MAX_LENGTH = 500;

/** Page size defaults for GET /tasks. */
export const TASK_LIST_DEFAULT_LIMIT = 25;
export const TASK_LIST_MAX_LIMIT = 100;

/** Query parameters accepted by GET /tasks. */
export interface ListTasksQuery {
  status?: TaskStatus;
  limit?: number;
  offset?: number;
}

/**
 * One page of tasks. `total` counts every task matching the filter, not just
 * the returned slice, so clients can render pagination controls.
 */
export interface TaskPage {
  items: Task[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Result of deleting a task. `deletedSubtasks` is counted before the delete;
 * the database cascade is what actually removes them.
 */
export interface DeleteTaskResult {
  id: string;
  deletedSubtasks: number;
}
