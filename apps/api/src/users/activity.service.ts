import {
  BASELINE_DAYS,
  BASELINE_MIN_SAMPLES,
  BASELINE_MONTHS,
  BASELINE_WEEKS,
  comparisonFor,
  type ActivityMetrics,
  type ActivitySeriesPoint,
} from '@adhd/shared';
import { Injectable, NotFoundException } from '@nestjs/common';

import {
  fromDateColumn,
  localCalendarDate,
  nextCalendarDate,
  toDateColumn,
  usableTimeZone,
} from '../common/calendar.js';
import { mondayOf } from '../notifications/weekly-digest.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SERIES_DAYS = 30;

/**
 * The metric view behind GET /me/activity.
 *
 * Everything is derived from `performance_events`, never from the task list:
 * counts and ratings must come from the same rows or the header can show "0
 * completed" beside a live rating after a reopen. `pending` is the one
 * current-state number and is queried separately.
 *
 * Days are the user's own, resolved once with `usableTimeZone` — the same rule
 * as streaks and reminders. Events already carry the local date they were
 * written with, so a later zone change does not rewrite history.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(userId: string, now: Date = new Date()): Promise<ActivityMetrics> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });

    if (!user) throw new NotFoundException('User not found');
    const timeZone = usableTimeZone(user.timezone);

    const today = localCalendarDate(now, timeZone);
    const tomorrow = nextCalendarDate(today);
    const thisMonday = mondayOf(today);
    const monthStart = `${today.slice(0, 7)}-01`;

    // The widest window any baseline needs, so the whole view is one query.
    const dailyBaselineStart = shiftDays(today, -BASELINE_DAYS);
    const weeklyBaselineStart = shiftDays(thisMonday, -BASELINE_WEEKS * 7);
    const monthlyBaselineStart = shiftMonths(monthStart, -BASELINE_MONTHS);
    // The monthly start is always the earliest of the three windows.
    const windowStart = monthlyBaselineStart;

    const [events, pending] = await Promise.all([
      this.prisma.performanceEvent.findMany({
        where: {
          userId,
          localDate: { gte: toDateColumn(windowStart), lt: toDateColumn(tomorrow) },
        },
        select: { localDate: true, score: true },
        orderBy: { localDate: 'asc' },
      }),
      this.prisma.task.count({
        where: {
          userId,
          status: { in: ['pending', 'in_progress'] },
          // The same draft fence as the default list: an unconfirmed suggestion
          // is not work the user has agreed to yet.
          NOT: { source: 'ai_suggested', confirmedAt: null },
        },
      }),
    ]);

    const days = groupByDay(events);

    const todayRating = mean(days.get(today));
    // Day-means on both sides: one busy day is one day of evidence, not twenty.
    const weekRating = meanOfDayMeans(days, thisMonday, tomorrow).value;
    const monthRating = meanOfDayMeans(days, monthStart, tomorrow).value;

    const dailyBaseline = meanOfDayMeans(days, dailyBaselineStart, today);
    const weeklyBaseline = meanOfDayMeans(days, weeklyBaselineStart, thisMonday);
    const monthlyBaseline = meanOfDayMeans(days, monthlyBaselineStart, monthStart);

    return {
      counts: {
        completedToday: countIn(days, today, tomorrow),
        completedThisWeek: countIn(days, thisMonday, tomorrow),
        completedThisMonth: countIn(days, monthStart, tomorrow),
      },
      pending,
      day: comparisonFor(todayRating, dailyBaseline.value, dailyBaseline.samples),
      week: comparisonFor(weekRating, weeklyBaseline.value, weeklyBaseline.samples),
      month: comparisonFor(monthRating, monthlyBaseline.value, monthlyBaseline.samples),
      series: buildSeries(days, today),
    };
  }
}

function shiftDays(calendarDate: string, days: number): string {
  return new Date(toDateColumn(calendarDate).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Calendar-month arithmetic that clamps to the first, which is all we need. */
function shiftMonths(calendarDate: string, months: number): string {
  const [year, month] = calendarDate.split('-').map(Number) as [number, number];
  const shifted = new Date(Date.UTC(year, month - 1 + months, 1));

  return shifted.toISOString().slice(0, 10);
}

function groupByDay(events: { localDate: Date; score: number }[]): Map<string, number[]> {
  const days = new Map<string, number[]>();

  for (const event of events) {
    const date = fromDateColumn(event.localDate);
    const scores = days.get(date) ?? [];
    scores.push(event.score);
    days.set(date, scores);
  }

  return days;
}

function mean(scores: number[] | undefined): number | null {
  if (!scores || scores.length === 0) return null;

  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

/** Every score in `[from, to)`, flattened across days. */
function flatten(days: Map<string, number[]>, from: string, to: string): number[] {
  const scores: number[] = [];

  for (const [date, dayScores] of days) {
    if (date >= from && date < to) scores.push(...dayScores);
  }

  return scores;
}

/**
 * A baseline is the mean of per-day means, not of raw events: one 20-task day
 * is one day of evidence, not twenty. `samples` is the number of days with
 * data, which is what the minimum-sample rule counts.
 */
function meanOfDayMeans(
  days: Map<string, number[]>,
  from: string,
  to: string,
): { value: number | null; samples: number } {
  const dayMeans: number[] = [];

  for (const [date, scores] of days) {
    if (date >= from && date < to) {
      const dayMean = mean(scores);
      if (dayMean !== null) dayMeans.push(dayMean);
    }
  }

  if (dayMeans.length < BASELINE_MIN_SAMPLES) {
    return { value: null, samples: dayMeans.length };
  }

  return {
    value: Math.round(dayMeans.reduce((sum, value) => sum + value, 0) / dayMeans.length),
    samples: dayMeans.length,
  };
}

function countIn(days: Map<string, number[]>, from: string, to: string): number {
  return flatten(days, from, to).length;
}

/** The last 30 local days, oldest first, with a null on quiet days. */
function buildSeries(days: Map<string, number[]>, today: string): ActivitySeriesPoint[] {
  const series: ActivitySeriesPoint[] = [];

  for (let offset = SERIES_DAYS - 1; offset >= 0; offset -= 1) {
    const date = shiftDays(today, -offset);
    series.push({ date, rating: mean(days.get(date)) });
  }

  return series;
}

