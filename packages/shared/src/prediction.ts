/**
 * "Suggest tasks": predictions from the user's own history (owner rulings,
 * 2026-10-09).
 *
 * The prediction is *what usually came next*. For the user's open and recently
 * finished tasks, the API finds similar tasks they finished in the past (by
 * embedding, in pgvector), then looks at what they finished in the few days
 * after those. Those follow-ons are offered as drafts.
 *
 * So a suggestion is always a title the user once wrote themselves — the model
 * only measures similarity, it never authors words — and the reason names the
 * past task it followed. Drafts like any other: nothing is created as a real
 * task until the user approves it, and reviewing pays the usual 1 XP.
 *
 * Not a schedule. Nothing is stored about *when* to suggest anything; a
 * prediction only exists because the user pressed the button. Recurring tasks
 * stay Phase 3.
 */

/** At most this many per press. More is a second to-do list, not help. */
export const MAX_PREDICTIONS = 3;

const REASON_MAX = 80;

/** Why a draft was suggested, naming the past task it followed. */
export function predictionReason(pastTitle: string): string {
  const prefix = 'Last time, after “';
  const room = REASON_MAX - prefix.length - 1;
  const title = pastTitle.trim();
  const shown = title.length > room ? `${title.slice(0, room - 1)}…` : title;

  return `${prefix}${shown}”`;
}

function normalise(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/u, '')
    .replace(/\s+/gu, ' ');
}

/** Whether two titles name the same task once case, spacing and end punctuation are ignored. */
export function sameTitle(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}
