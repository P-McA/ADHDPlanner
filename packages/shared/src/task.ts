import type { EstimateMinutes } from './estimation.js';

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
  /** Position among its parent's steps, 0 first; null for a top-level task. */
  stepOrder: number | null;
  /**
   * The estimate the user has confirmed, in minutes (one of `ESTIMATE_BUCKETS`);
   * null when there is none. Theirs: set by accepting a suggestion or directly.
   */
  estimateMinutes: EstimateMinutes | null;
  /** The model's suggested estimate, awaiting review; never counted as theirs. */
  suggestedEstimateMinutes: EstimateMinutes | null;
  /**
   * Why this draft was predicted ("Last time, after …"); null for every task
   * that did not come from "Suggest tasks". Read-only: only the API writes it.
   */
  suggestionReason: string | null;
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
  Partial<
    Pick<Task, 'description' | 'manualPriority' | 'dueAt' | 'source' | 'parentTaskId' | 'estimateMinutes'>
  >;

/**
 * Fields a client may change on an existing task.
 *
 * `source` and `parentTaskId` are creation-time only: provenance should not be
 * rewritable after the fact, and allowing re-parenting would let clients build
 * cycles in the decomposition tree with no cheap way to detect them.
 */
export type UpdateTaskInput = Partial<
  // `estimateMinutes` is the user's own estimate, set directly. The *suggested*
  // one is not here: only the model writes it, and it leaves only through
  // POST /tasks/:id/estimate/accept or /dismiss — never through an edit.
  Pick<Task, 'title' | 'description' | 'status' | 'manualPriority' | 'dueAt' | 'estimateMinutes'>
>;

/** Body of POST /tasks/:id/estimate/accept: the suggestion, or a correction of it. */
export interface AcceptEstimateInput {
  /** A different bucket than suggested; omit to take the suggestion as it is. */
  minutes?: EstimateMinutes;
}

/** Title bounds, shared so client-side validation matches the API's. */
export const TASK_TITLE_MIN_LENGTH = 1;
export const TASK_TITLE_MAX_LENGTH = 500;

/** Page size defaults for GET /tasks. */
export const TASK_LIST_DEFAULT_LIMIT = 25;
export const TASK_LIST_MAX_LIMIT = 100;

/**
 * The only value `include` accepts on GET /tasks.
 *
 * A single-value union rather than a boolean because the parameter names what
 * is being added to the page, and a second opt-in (archived, say) should extend
 * this list rather than invent a second flag.
 */
export const TASK_LIST_INCLUDES = ['drafts'] as const;
export type TaskListInclude = (typeof TASK_LIST_INCLUDES)[number];

/** Query parameters accepted by GET /tasks. */
export interface ListTasksQuery {
  status?: TaskStatus;
  limit?: number;
  offset?: number;
  /**
   * Opt in to unconfirmed AI drafts, which the default page excludes.
   *
   * The fence is server-side: a client that forgets this parameter cannot
   * accidentally show a suggestion nobody approved as if it were the user's own
   * work. Only a caller that has somewhere to *put* drafts — a review list —
   * asks for them, and asking is the acknowledgement.
   */
  include?: TaskListInclude;
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
