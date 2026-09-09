/**
 * Push notification contracts (Phase 1.5, Milestone D).
 *
 * Reminders are the one thing in this app that speaks without being spoken to,
 * so the rules here are about restraint: never about a draft the user has not
 * confirmed, never twice for the same thing on the same day, and never to a
 * device that has told us it is gone.
 */

/**
 * A device registration reminders are delivered to.
 *
 * One row per device, not per user: a user with a phone and a tablet gets both,
 * and losing one must not silence the other.
 */
export interface PushToken {
  id: string;
  /** The Expo push token, e.g. `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]`. */
  token: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/** Body of `POST /me/push-tokens`. */
export interface RegisterPushTokenInput {
  token: string;
}

/**
 * Whether a string could be an Expo push token.
 *
 * Checked at the edge so a value that can never work is a 400 the client can
 * act on, rather than a row that fails silently on every send for ever. The
 * inside of the brackets is deliberately unconstrained — that is Expo's opaque
 * identifier, and pinning its alphabet here would turn their format change into
 * our outage. Both spellings are accepted because Expo emits both.
 */
export function isExpoPushToken(value: string): boolean {
  return /^Expo(nent)?PushToken\[[^\s\][]+\]$/.test(value);
}

/** Why the API might send a user a notification. */
export const NOTIFICATION_KINDS = ['due_reminder', 'streak_nudge'] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * The streak length at which the nudge starts firing.
 *
 * Three, because a one- or two-day run is not yet a thing worth protecting, and
 * telling someone they are about to break a one-day streak is a notification
 * that costs attention and buys nothing.
 */
export const STREAK_NUDGE_MIN_DAYS = 3;

/** BullMQ queue carrying the periodic reminder sweep. */
export const REMINDER_QUEUE = 'reminders';

/**
 * How long the push provider gets before the sweep gives up on a batch.
 *
 * A hung provider must not hold a sweep open indefinitely — the next run would
 * pile up behind it, and the claims it already wrote would block the retry.
 */
export const PUSH_SEND_TIMEOUT_MS = 15_000;

/**
 * Largest number of messages Expo accepts in one request.
 *
 * Their documented limit. Batches larger than this are split by the adapter;
 * it is here rather than there because the fake in the test suite has to
 * reproduce the same chunking to be a faithful stand-in.
 */
export const PUSH_BATCH_SIZE = 100;

/**
 * How often the sweep runs. Hourly, on the hour.
 *
 * Hourly rather than once a day because "today" is a different span of
 * instants for every user: a single daily run would have to pick one timezone
 * to be right for. The sweep instead runs often and lets each user's own
 * calendar date and local clock decide, with the dispatch ledger making the
 * repetition harmless — see `notification_dispatches` in schema.prisma.
 */
export const REMINDER_SWEEP_CRON = '0 * * * *';

/**
 * The local hours during which a user may be notified, inclusive of the start
 * and exclusive of the end.
 *
 * An hourly sweep with no window would deliver every reminder at 00:00 local,
 * because that is the first run of the user's new day — the reminder would
 * arrive while they were asleep and be gone by morning, which is worse than
 * not sending it. This is a reminder app for people with ADHD; a 3am push is
 * not a neutral event.
 */
export const REMINDER_WINDOW_START_HOUR = 9;
export const REMINDER_WINDOW_END_HOUR = 21;

/**
 * The most *new* due reminders one sweep will send a single user.
 *
 * A user with thirty tasks due today does not need thirty notifications; they
 * need to look at their list. Beyond a handful, a reminder stops being a
 * prompt and becomes a wall, and the reliable response to a wall is to turn
 * notifications off — after which none of this works at all.
 *
 * It is a cap on *sends*, not on candidates, and an already-claimed task does
 * not count against it. So the overflow is not dropped: it rolls into the next
 * sweep, and the tasks the user has finished in the meantime never come back.
 */
export const DUE_REMINDER_MAX_PER_SWEEP = 5;
