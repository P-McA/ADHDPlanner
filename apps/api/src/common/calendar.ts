/**
 * Turning an instant into *the user's* day.
 *
 * Extracted from GamificationService, which owned these privately until the
 * reminder sweep needed the same answers. Two definitions of "what day is it
 * for this user" would eventually disagree, and the day they disagreed the
 * streak would say the run is alive while the nudge said it was about to break.
 * One definition, one place.
 */

const MS_PER_DAY = 86_400_000;

/**
 * The user's calendar date at `instant`, as YYYY-MM-DD.
 *
 * `en-CA` is the shortest way to get ISO-ordered date parts out of Intl. This
 * is the single place a timezone turns into a day, which is what keeps "did
 * they complete something yesterday" answerable without server time leaking in.
 */
export function localCalendarDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * A DATE column has no timezone, and Prisma round-trips it through a Date
 * anchored at UTC midnight. Anchoring here the same way keeps the value that
 * goes in identical to the one that comes back.
 */
export function toDateColumn(calendarDate: string): Date {
  return new Date(`${calendarDate}T00:00:00.000Z`);
}

/** The calendar date one day before the given one. */
export function previousCalendarDate(calendarDate: string): string {
  return new Date(toDateColumn(calendarDate).getTime() - MS_PER_DAY).toISOString().slice(0, 10);
}

/** Reads a DATE column back as YYYY-MM-DD without reintroducing a timezone. */
export function fromDateColumn(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * The half-open UTC interval covering one local calendar day.
 *
 * Reminders ask "which tasks are due today", and `tasks.due_at` is a
 * `timestamptz` — an instant — while "today" is a local calendar day. The
 * conversion has to happen somewhere, and doing it here means the query stays
 * an indexed range scan on `due_at` rather than a per-row timezone conversion
 * that no index can help.
 *
 * The offset is resolved at *both* ends rather than once, because a day
 * containing a DST transition is 23 or 25 hours long, not 24. Taking the start
 * offset and adding a day would put the boundary an hour out twice a year — and
 * an hour out at midnight is a whole day's worth of tasks on the wrong side.
 */
export function localDayBoundsUtc(calendarDate: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: localMidnightUtc(calendarDate, timeZone),
    end: localMidnightUtc(nextCalendarDate(calendarDate), timeZone),
  };
}

/** The calendar date one day after the given one. */
export function nextCalendarDate(calendarDate: string): string {
  return new Date(toDateColumn(calendarDate).getTime() + MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The UTC instant at which `calendarDate` begins in `timeZone`.
 *
 * Intl converts an instant to a zone, never the reverse, so this inverts it:
 * take UTC midnight as a first guess, ask what the zone's offset is there, and
 * subtract it. The second pass re-reads the offset at the corrected instant and
 * subtracts it **from the original target again** — not from the running value.
 * That distinction is the whole correctness of this function: subtracting
 * cumulatively double-counts the offset, which a probe across twelve
 * zone/date pairs caught immediately (every non-UTC zone landed a day early).
 *
 * Two passes suffice because the only thing the first pass can get wrong is
 * landing on the far side of a DST transition, and the second reads the offset
 * that actually applies at local midnight.
 */
function localMidnightUtc(calendarDate: string, timeZone: string): Date {
  const target = toDateColumn(calendarDate).getTime();

  let instant = target - offsetAt(new Date(target), timeZone);
  instant = target - offsetAt(new Date(instant), timeZone);

  return new Date(instant);
}

/**
 * How far ahead of UTC `timeZone` is at `instant`, in milliseconds.
 *
 * Formats the instant as if it were UTC wall-clock and differences the two,
 * which is the standard way to recover an offset from Intl without a library.
 */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const at = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';

  // `24` for midnight is legal in some ICU versions; normalise it to `00`.
  const hour = at('hour') === '24' ? '00' : at('hour');
  const asUtc = Date.parse(
    `${at('year')}-${at('month')}-${at('day')}T${hour}:${at('minute')}:${at('second')}.000Z`,
  );

  return asUtc - instant.getTime();
}

/**
 * The hour of the local clock at `instant`, 0–23.
 *
 * The reminder sweep runs hourly and has to decide whether *this* user is
 * awake, which is a question about their wall clock and nothing else.
 */
export function localHour(instant: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    hour: '2-digit',
  }).format(instant);

  // Some ICU builds render midnight as `24`; the rest of this file normalises
  // it the same way.
  return Number(hour) % 24;
}

/**
 * A timezone Intl will accept, falling back to UTC when the stored value is
 * not one.
 *
 * A bad profile value must never be able to stop work happening — the same
 * rule GamificationService applies before touching a streak. Being reminded in
 * the wrong timezone is recoverable by editing a profile field; a sweep that
 * throws part-way through leaves every user after that one unnotified.
 */
export function usableTimeZone(candidate: string | null | undefined): string {
  if (!candidate) {
    return 'UTC';
  }

  try {
    localCalendarDate(new Date(), candidate);
    return candidate;
  } catch {
    return 'UTC';
  }
}
