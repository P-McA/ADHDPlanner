import {
  calendarDaysBetween,
  STREAK_FREEZE_MIN_DAYS,
} from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';

import {
  fromDateColumn,
  localCalendarDate,
  previousCalendarDate,
  toDateColumn,
  usableTimeZone,
} from '../common/calendar.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface FreezeSweepSummary {
  /** Streaks that held at least one freeze and were long enough to protect. */
  considered: number;
  /** Freezes actually spent. */
  spent: number;
}

/**
 * Spends a streak freeze on a missed day.
 *
 * Runs hourly and looks at each user on *their* calendar, the same rule as
 * streaks and reminders. A freeze is spent only when the run is long enough to
 * be worth protecting and the user has enough freezes to bridge the whole gap;
 * otherwise the run is left to break on the next completion, which is what
 * `touchStreak` already does.
 *
 * The write is conditional on the `lastActiveDate` that was read, so a
 * completion landing between the read and the write wins and the freeze is not
 * spent for a day that was in fact active.
 */
@Injectable()
export class StreakFreezeService {
  private readonly logger = new Logger(StreakFreezeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async runSweep(now: Date = new Date()): Promise<FreezeSweepSummary> {
    const summary: FreezeSweepSummary = { considered: 0, spent: 0 };

    const streaks = await this.prisma.streak.findMany({
      where: {
        freezes: { gt: 0 },
        currentStreak: { gte: STREAK_FREEZE_MIN_DAYS },
        lastActiveDate: { not: null },
      },
      select: {
        userId: true,
        freezes: true,
        currentStreak: true,
        lastActiveDate: true,
        user: { select: { timezone: true } },
      },
    });

    for (const streak of streaks) {
      if (streak.lastActiveDate === null) continue;

      summary.considered += 1;

      if (streak.currentStreak < STREAK_FREEZE_MIN_DAYS) continue;

      const timeZone = usableTimeZone(streak.user.timezone);
      const yesterday = previousCalendarDate(localCalendarDate(now, timeZone));
      const lastActive = fromDateColumn(streak.lastActiveDate);

      // Active today or yesterday: nothing missed.
      if (lastActive >= yesterday) continue;

      const gap = calendarDaysBetween(lastActive, yesterday);

      // More missed days than freezes: leave the run to break.
      if (gap > streak.freezes) continue;

      const claim = await this.prisma.streak.updateMany({
        where: {
          userId: streak.userId,
          freezes: { gte: gap },
          lastActiveDate: toDateColumn(lastActive),
        },
        data: {
          freezes: { decrement: gap },
          lastActiveDate: toDateColumn(yesterday),
        },
      });

      if (claim.count === 0) {
        // A completion or another sweep got there first.
        continue;
      }

      summary.spent += gap;
      this.logger.log(`Spent ${String(gap)} freeze(s) for ${streak.userId}`);
    }

    return summary;
  }
}
