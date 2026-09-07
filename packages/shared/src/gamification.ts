import type { TaskPriority } from './task.js';

/**
 * Why a task earned XP. The ledger is append-only, so this is the only record
 * of provenance — there is no balance column to reconcile against.
 *
 * docs/adhd_tracker.md also lists `badge` and `quest`; both are Phase 2, so
 * they are deliberately absent here. Adding a value later is an additive
 * migration (`ALTER TYPE ... ADD VALUE`), which is cheap; carrying a value the
 * code cannot produce is not.
 */
export const XP_EVENT_TYPES = ['task_complete', 'streak_bonus'] as const;
export type XpEventType = (typeof XP_EVENT_TYPES)[number];

/** XP every completed task is worth before its priority modifier. */
export const XP_TASK_COMPLETE_BASE = 10;

/**
 * Added to the base for finishing something that mattered more.
 *
 * Keyed by TaskPriority so adding a priority is a compile error here rather
 * than a silent zero. Note `med`, not `medium` — that is what the enum in
 * docs/adhd_tracker.md and schema.prisma call it.
 */
export const XP_PRIORITY_MODIFIER: Record<TaskPriority, number> = {
  low: 0,
  med: 0,
  high: 3,
  urgent: 5,
};

/** XP required to advance one level. */
export const XP_PER_LEVEL = 100;

/** What a single task completion is worth at the given priority. */
export function xpForCompletion(priority: TaskPriority): number {
  return XP_TASK_COMPLETE_BASE + XP_PRIORITY_MODIFIER[priority];
}

/**
 * Level is derived from the ledger on every read, never stored, so it cannot
 * drift from the events that produced it.
 *
 * A new user with 0 XP is level 1, not level 0: levels are a display of
 * progress, and starting at zero reads as "you do not count yet". So level 1
 * spans 0–99 XP, level 2 spans 100–199, and so on.
 */
export function levelForXp(totalXp: number): number {
  if (totalXp <= 0) return 1;
  return Math.floor(totalXp / XP_PER_LEVEL) + 1;
}

/** The gamification summary behind GET /me/stats. */
export interface UserStats {
  /** Sum of every xp_events row for the user. */
  totalXp: number;
  /** Derived from totalXp via levelForXp; never persisted. */
  level: number;
  currentStreak: number;
  longestStreak: number;
  /**
   * Last day the user completed something, as a calendar date (YYYY-MM-DD) in
   * *their* timezone. Null until their first completion.
   */
  lastActiveDate: string | null;
}
