/**
 * Starter badges — the Phase 1 "3–5 starter badges" promise.
 *
 * A badge is something the user *has*, not a payment, so it is not an
 * `XpEventType` and has no XP value: it lives in its own `user_badges` table,
 * one row per (user, badge), and is awarded at most once.
 *
 * The keys are a string union here rather than a database enum on purpose:
 * adding or renaming a badge is a change to this file and its award site, not
 * a migration. The table stores the key as text.
 *
 * These three are fixed triggers on things the app already records — finishing
 * something, keeping a run going, reviewing a suggestion. Badges "tied to real
 * behaviour patterns" (Phase 2 in docs/adhd_tracker.md) are deliberately not
 * attempted here.
 */
export const BADGE_KEYS = ['first_task_done', 'streak_3', 'first_suggestion_reviewed'] as const;

export type BadgeKey = (typeof BADGE_KEYS)[number];

/** The run length that earns `streak_3`. */
export const STREAK_BADGE_DAYS = 3;

export interface BadgeDefinition {
  key: BadgeKey;
  name: string;
  description: string;
}

export const BADGES: Record<BadgeKey, BadgeDefinition> = {
  first_task_done: {
    key: 'first_task_done',
    name: 'First win',
    description: 'Finished your first task.',
  },
  streak_3: {
    key: 'streak_3',
    name: 'On a roll',
    description: `Finished something ${String(STREAK_BADGE_DAYS)} days running.`,
  },
  first_suggestion_reviewed: {
    key: 'first_suggestion_reviewed',
    name: 'Second opinion',
    description: 'Reviewed your first AI suggestion.',
  },
};

/** One badge the user has earned, as `GET /me/badges` returns it. */
export interface EarnedBadge extends BadgeDefinition {
  /** ISO-8601; when it was first earned. A badge is never re-awarded. */
  awardedAt: string;
}

export function isBadgeKey(value: string): value is BadgeKey {
  return (BADGE_KEYS as readonly string[]).includes(value);
}
