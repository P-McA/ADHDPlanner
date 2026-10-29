import type { TrackingMode } from './activity.js';

/**
 * User contract. Identity itself is owned by Clerk; this is the
 * application-side projection of a user, linked to it by `clerkId`.
 */
export interface User {
  /** Internal UUID primary key. This is what `Task.userId` references. */
  id: string;
  /** Clerk's subject id (`user_...`) — the link back to the identity provider. */
  clerkId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  /** IANA zone name, e.g. "Europe/London". */
  timezone: string;
  /** How progress is shown. `metrics` is the adult default; `xp` is rewards. */
  trackingMode: TrackingMode;
  /** Whether the performance rating number is shown beside the colour. */
  showElo: boolean;
  /** When the first-run explanation was dismissed, ISO 8601; null until then. */
  onboardedAt: string | null;
  createdAt: string;
}

/**
 * Body of `PATCH /me`. Every field is optional so a client can change one
 * setting without re-sending the others.
 *
 * The time zone decides what "today" means for streaks, reminders and Next up,
 * so the phone reports the zone it is actually in rather than every account
 * sitting on the UTC default. The tracking fields are display preferences.
 */
export interface UpdateProfileInput {
  timezone?: string;
  trackingMode?: TrackingMode;
  showElo?: boolean;
}

/**
 * Whether `value` is an IANA zone name this runtime can resolve, such as
 * "Europe/London", "Etc/GMT+12" or "UTC".
 *
 * Shape first, then Intl: recent engines also accept raw offsets ("+01:00"),
 * which name no place and so cannot follow summer time — a fixed offset stored
 * in March would be an hour out by April. The phone and the API share this one
 * rule so they cannot disagree about a real device's zone.
 */
export function isIanaTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z_]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
