/**
 * Words for a task row's meta line.
 *
 * Display only, on the phone's own calendar: "Next up" ranking stays the API's,
 * on the user's stored time zone. Something due earlier today is "Today", not
 * overdue — the day is not over, and calling it late would be a small, needless
 * jab at exactly the moment the user is looking at their list.
 */
export type DueTone = 'overdue' | 'today' | 'soon' | 'later';

const DAY_MS = 86_400_000;

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

export function dueLabel(dueAt: string | null, now: Date = new Date()): { text: string; tone: DueTone } | null {
  if (dueAt === null) return null;

  const due = new Date(dueAt);
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS);

  if (days < 0) return { text: 'Overdue', tone: 'overdue' };
  if (days === 0) return { text: 'Today', tone: 'today' };
  if (days === 1) return { text: 'Tomorrow', tone: 'soon' };
  if (days < 7) return { text: due.toLocaleDateString('en-GB', { weekday: 'short' }), tone: 'soon' };

  return { text: due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), tone: 'later' };
}
