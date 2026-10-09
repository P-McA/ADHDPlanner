import { type EstimateMinutes, formatEstimate } from './estimation.js';
import type { Task, TaskPriority } from './task.js';

/**
 * "Next up": the urgency score behind the open-task order (owner ruling,
 * 2026-10-09). Plain arithmetic, no model — the user can read off *why* a task
 * is where it is, which a learned ranking could not tell them.
 *
 * Three parts, weighted so the order means something:
 * - **when it is due** dominates: overdue beats any priority on an undated
 *   task. The due date is a fact about the world; priority is a feeling
 *   about it.
 * - **manual priority** orders tasks due around the same time.
 * - **a short task** (the user's own estimate ≤ 30 min) gets a quick-win
 *   boost, worth less than a day of urgency. Only the *user's* estimate
 *   counts: a model suggestion nobody accepted must not move their day.
 *
 * Time-zone free on purpose: the caller resolves `dueInDays` on the user's
 * own calendar, the same rule as streaks, and passes the number in.
 */

export interface RankInput {
  /** Calendar days from the user's today to the due date; negative is overdue. */
  dueInDays: number | null;
  priority: TaskPriority;
  /** The user's own estimate — never the suggested one. */
  estimateMinutes: EstimateMinutes | null;
}

export interface TaskRank {
  score: number;
  /** Short, user-facing reasons, most important first; empty when nothing is notable. */
  reasons: string[];
}

/** A task as the "Next up" list returns it: the task, plus why it is where it is. */
export type RankedTask = Task & { rank: TaskRank };

/** One page of GET /tasks/next. `nextCursor` is null on the last page. */
export interface RankedTaskPage {
  items: RankedTask[];
  nextCursor: string | null;
}

const PRIORITY_POINTS: Record<TaskPriority, number> = { urgent: 30, high: 20, med: 10, low: 0 };

/** The window "Due this week" covers, counting today as day 0. */
const THIS_WEEK_DAYS = 7;

/** At or under this, a task is a quick win. */
const QUICK_WIN_MAX_MINUTES = 30;

function dueRank(dueInDays: number | null): { points: number; reason: string | null } {
  if (dueInDays === null) return { points: 0, reason: null };
  if (dueInDays < 0) return { points: 100, reason: 'Overdue' };
  if (dueInDays === 0) return { points: 80, reason: 'Due today' };
  if (dueInDays === 1) return { points: 60, reason: 'Due tomorrow' };
  if (dueInDays < THIS_WEEK_DAYS) return { points: 40, reason: 'Due this week' };

  // Dated but far off still outranks undated: a date is a commitment.
  return { points: 15, reason: null };
}

export function rankTask(task: RankInput): TaskRank {
  const due = dueRank(task.dueInDays);
  const reasons: string[] = [];
  let score = due.points + PRIORITY_POINTS[task.priority];

  if (due.reason !== null) reasons.push(due.reason);
  if (task.priority === 'urgent') reasons.push('Urgent');
  if (task.priority === 'high') reasons.push('High priority');

  const minutes = task.estimateMinutes;

  if (minutes !== null && minutes <= QUICK_WIN_MAX_MINUTES) {
    score += minutes <= 15 ? 12 : 6;
    reasons.push(`Quick win · ${formatEstimate(minutes)}`);
  }

  return { score, reasons };
}

/** Highest score first, then id — a total order, so pages never overlap or skip. */
export function compareRanked(a: { id: string; score: number }, b: { id: string; score: number }): number {
  if (a.score !== b.score) return b.score - a.score;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whole days from one `YYYY-MM-DD` calendar date to another; negative when `to` is earlier. */
export function calendarDaysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);

  return Math.round(ms / 86_400_000);
}
