import { dueLabel } from './task-meta';

/**
 * The due-date words on a task row. Display only: ranking is the API's, on the
 * user's stored time zone; this reads the phone's own clock, which is the
 * calendar the person holding it is living on.
 */
describe('dueLabel', () => {
  // Thursday 9 October 2026, mid-afternoon local time.
  const NOW = new Date(2026, 9, 9, 15, 0, 0);
  const on = (day: number, hour = 12) => new Date(2026, 9, day, hour, 0, 0).toISOString();

  it.each([
    [on(7), 'Overdue', 'overdue'],
    [on(9, 9), 'Today', 'today'],
    [on(9, 23), 'Today', 'today'],
    [on(10), 'Tomorrow', 'soon'],
    [on(13), 'Tue', 'soon'],
    [on(20), '20 Oct', 'later'],
  ] as const)('calls %s "%s"', (dueAt, text, tone) => {
    expect(dueLabel(dueAt, NOW)).toEqual({ text, tone });
  });

  it('says nothing for a task with no due date', () => {
    expect(dueLabel(null, NOW)).toBeNull();
  });

  it('calls something due earlier today "Today", not overdue — the day is not over', () => {
    expect(dueLabel(on(9, 8), NOW)).toEqual({ text: 'Today', tone: 'today' });
  });
});
