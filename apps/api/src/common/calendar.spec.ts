import { describe, expect, it } from 'vitest';

import {
  fromDateColumn,
  localCalendarDate,
  localDayBoundsUtc,
  localHour,
  nextCalendarDate,
  previousCalendarDate,
  toDateColumn,
  usableTimeZone,
} from './calendar.js';

/**
 * The day-boundary maths, tested where it actually breaks.
 *
 * `localDayBoundsUtc` is the one non-obvious function here: Intl converts an
 * instant to a zone and never the reverse, so the inverse is computed by
 * correction, and the first version of it was wrong — it subtracted the offset
 * cumulatively and put every non-UTC zone a day early. The round-trip cases
 * below are what caught that, so they are written as properties of the
 * boundary rather than as expected literals: the first millisecond of the day
 * is in the day, the millisecond before it is not, and the last millisecond
 * before the end is still in it.
 */
describe('calendar', () => {
  describe('localCalendarDate', () => {
    it('resolves an instant to the day it fell on where the user is', () => {
      // 23:30 UTC is already tomorrow in Sydney and still today in London.
      const instant = new Date('2026-09-09T23:30:00.000Z');

      expect(localCalendarDate(instant, 'Europe/London')).toBe('2026-09-10');
      expect(localCalendarDate(instant, 'America/New_York')).toBe('2026-09-09');
      expect(localCalendarDate(instant, 'Australia/Sydney')).toBe('2026-09-10');
    });

    it('disagrees with UTC either side of midnight, which is the whole point', () => {
      // If this ever agreed, server time would have leaked back in.
      const earlyMorningUtc = new Date('2026-09-09T02:00:00.000Z');

      expect(localCalendarDate(earlyMorningUtc, 'UTC')).toBe('2026-09-09');
      expect(localCalendarDate(earlyMorningUtc, 'America/Los_Angeles')).toBe('2026-09-08');
    });
  });

  describe('date column round-trip', () => {
    it('survives a trip through a DATE column unchanged', () => {
      expect(fromDateColumn(toDateColumn('2026-09-09'))).toBe('2026-09-09');
    });

    it('steps backwards and forwards across a month boundary', () => {
      expect(previousCalendarDate('2026-09-01')).toBe('2026-08-31');
      expect(nextCalendarDate('2026-08-31')).toBe('2026-09-01');
    });

    it('handles a leap day, which is where naive date arithmetic gives up', () => {
      expect(nextCalendarDate('2028-02-28')).toBe('2028-02-29');
      expect(previousCalendarDate('2028-03-01')).toBe('2028-02-29');
    });
  });

  describe('localDayBoundsUtc', () => {
    /**
     * The property that defines a correct boundary, checked by asking the
     * *other* function what day each edge instant falls on. Deliberately not
     * asserted against hand-computed UTC literals: those would encode the same
     * arithmetic the function does, so a wrong function and a wrong expectation
     * would agree.
     */
    const assertBounds = (calendarDate: string, timeZone: string): void => {
      const { start, end } = localDayBoundsUtc(calendarDate, timeZone);

      expect(localCalendarDate(start, timeZone), `${timeZone} start`).toBe(calendarDate);
      expect(localCalendarDate(new Date(start.getTime() - 1), timeZone), `${timeZone} before`).not.toBe(
        calendarDate,
      );
      expect(localCalendarDate(new Date(end.getTime() - 1), timeZone), `${timeZone} last ms`).toBe(
        calendarDate,
      );
      expect(localCalendarDate(end, timeZone), `${timeZone} end`).not.toBe(calendarDate);
    };

    it.each([
      ['UTC', '2026-09-09'],
      ['Europe/London', '2026-09-09'],
      ['Europe/London', '2026-01-15'],
      ['America/New_York', '2026-09-09'],
      ['Asia/Kolkata', '2026-09-09'],
      ['Pacific/Chatham', '2026-09-09'],
      ['Australia/Sydney', '2026-09-09'],
    ])('brackets a day exactly in %s on %s', (timeZone, calendarDate) => {
      assertBounds(calendarDate, timeZone);
    });

    it.each([
      ['Europe/London', '2026-03-29', 23],
      ['Europe/London', '2026-10-25', 25],
      ['America/New_York', '2026-03-08', 23],
      ['America/New_York', '2026-11-01', 25],
      ['Australia/Lord_Howe', '2026-04-05', 24.5],
    ])('brackets the %s DST day on %s, which is %s hours long', (timeZone, calendarDate, hours) => {
      // A day with a transition in it is not 24 hours. Taking the start offset
      // and adding a day — the obvious implementation — puts the far boundary
      // an hour out twice a year, which is a whole evening of due tasks landing
      // on the wrong side. Lord Howe shifts by 30 minutes, so it also catches
      // anything that assumes offsets are whole hours.
      assertBounds(calendarDate, timeZone);

      const { start, end } = localDayBoundsUtc(calendarDate, timeZone);
      expect((end.getTime() - start.getTime()) / 3_600_000).toBe(hours);
    });

    it('produces a half-open interval, so consecutive days neither gap nor overlap', () => {
      // Two adjacent days must tile the timeline exactly: any gap is a task
      // that is reminded about on no day at all, any overlap is one reminded
      // about twice.
      const first = localDayBoundsUtc('2026-10-25', 'Europe/London');
      const second = localDayBoundsUtc('2026-10-26', 'Europe/London');

      expect(first.end.getTime()).toBe(second.start.getTime());
    });
  });
});

describe('localHour', () => {
  it('reads the clock where the user is, not where the server is', () => {
    const instant = new Date('2026-09-09T14:00:00.000Z');

    expect(localHour(instant, 'UTC')).toBe(14);
    expect(localHour(instant, 'Europe/London')).toBe(15);
    expect(localHour(instant, 'America/Los_Angeles')).toBe(7);
    // The middle of the night, which is what the notify window exists to avoid.
    expect(localHour(instant, 'Pacific/Auckland')).toBe(2);
  });

  it('reports midnight as 0, whatever ICU calls it', () => {
    // Some ICU builds render midnight as `24` under hour12: false. A window
    // check of `hour >= 9` would then let a 24 through as if it were 3pm.
    expect(localHour(new Date('2026-09-09T00:00:00.000Z'), 'UTC')).toBe(0);
  });
});

describe('usableTimeZone', () => {
  it('keeps a zone Intl recognises', () => {
    expect(usableTimeZone('Pacific/Chatham')).toBe('Pacific/Chatham');
  });

  it.each([[null], [undefined], [''], ['Middle/Earth']])(
    'falls back to UTC rather than throwing on %s',
    (candidate) => {
      // A bad profile value must never stop work happening. In the sweep, a
      // throw here would leave every user after this one in the loop unnotified.
      expect(usableTimeZone(candidate)).toBe('UTC');
    },
  );
});
