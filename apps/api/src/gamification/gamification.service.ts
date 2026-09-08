import type { TaskPriority, UserStats } from '@adhd/shared';
import { levelForXp, XP_DRAFT_REVIEW, xpForCompletion } from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

/** What awardForCompletion needs to know about the task that just finished. */
export interface CompletionAward {
  userId: string;
  taskId: string;
  priority: TaskPriority;
  /**
   * The instant the completion happened. Injected rather than read from the
   * clock inside the service so streak behaviour around midnight is testable
   * without freezing time globally.
   */
  now: Date;
}

const MS_PER_DAY = 86_400_000;

/**
 * The user's calendar date at `instant`, as YYYY-MM-DD.
 *
 * `en-CA` is the shortest way to get ISO-ordered date parts out of Intl. This
 * is the single place a timezone turns into a day, which is what keeps "did
 * they complete something yesterday" answerable without server time leaking in.
 */
function localCalendarDate(instant: Date, timeZone: string): string {
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
function toDateColumn(calendarDate: string): Date {
  return new Date(`${calendarDate}T00:00:00.000Z`);
}

/** The calendar date one day before the given one. */
function previousCalendarDate(calendarDate: string): string {
  return new Date(toDateColumn(calendarDate).getTime() - MS_PER_DAY).toISOString().slice(0, 10);
}

/** Reads a DATE column back as YYYY-MM-DD without reintroducing a timezone. */
function fromDateColumn(value: Date): string {
  return value.toISOString().slice(0, 10);
}

@Injectable()
export class GamificationService {
  private readonly logger = new Logger(GamificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes the XP ledger row for a completed task and advances the streak.
   *
   * Takes the transaction client rather than opening its own: the caller
   * (TasksService.update) already has the task update open in a transaction,
   * and a task must never be able to show as done with no XP behind it, or
   * vice versa.
   *
   * Awarding is the caller's decision — this method does not check whether the
   * task was already done. The transition guard lives in TasksService.update,
   * where the previous status is known.
   */
  async awardForCompletion(tx: Prisma.TransactionClient, award: CompletionAward): Promise<void> {
    const xpAmount = xpForCompletion(award.priority);

    // Insert first, streak second: the atomicity test depends on a failure
    // between the two rolling the ledger row back too.
    await tx.xpEvent.create({
      data: {
        userId: award.userId,
        taskId: award.taskId,
        type: 'task_complete',
        xpAmount,
      },
    });

    await this.touchStreak(tx, award.userId, award.now);
  }

  /**
   * Writes the ledger row for reviewing an AI suggestion — approve or reject.
   *
   * No streak touch, deliberately. The streak measures days the user finished
   * something; letting a review extend it would let someone keep a 40-day run
   * alive by tapping Reject on a suggestion they never intended to do, which
   * turns the one honest number in the app into a participation trophy.
   *
   * Like awardForCompletion this does not decide *whether* to pay. The caller
   * (TasksService.approveDraft / rejectDraft) pays only when its conditional
   * update actually changed a row, which is what makes one draft worth exactly
   * one XP however many times the button is pressed.
   */
  async awardForDraftReview(
    tx: Prisma.TransactionClient,
    review: { userId: string; taskId: string },
  ): Promise<void> {
    await tx.xpEvent.create({
      data: {
        userId: review.userId,
        taskId: review.taskId,
        type: 'draft_reviewed',
        xpAmount: XP_DRAFT_REVIEW,
      },
    });
  }

  /**
   * Advances the user's streak for a completion at `now`.
   *
   * Three cases, all decided in the user's own timezone: another completion on
   * a day already counted changes nothing, a completion the day after the last
   * one extends the run, and anything further back starts a new run at 1.
   */
  private async touchStreak(
    tx: Prisma.TransactionClient,
    userId: string,
    now: Date,
  ): Promise<void> {
    const timezone = await this.timezoneFor(tx, userId);
    const today = localCalendarDate(now, timezone);

    const existing = await tx.streak.findUnique({ where: { userId } });

    if (!existing || existing.lastActiveDate === null) {
      await tx.streak.upsert({
        where: { userId },
        create: {
          userId,
          currentStreak: 1,
          longestStreak: 1,
          lastActiveDate: toDateColumn(today),
        },
        update: {
          currentStreak: 1,
          longestStreak: Math.max(1, existing?.longestStreak ?? 0),
          lastActiveDate: toDateColumn(today),
        },
      });
      return;
    }

    const lastActive = fromDateColumn(existing.lastActiveDate);
    if (lastActive === today) {
      // Already counted today. Completing five tasks in an afternoon is one
      // day of the habit, not five.
      return;
    }

    const isConsecutive = lastActive === previousCalendarDate(today);
    const currentStreak = isConsecutive ? existing.currentStreak + 1 : 1;

    await tx.streak.update({
      where: { userId },
      data: {
        currentStreak,
        longestStreak: Math.max(currentStreak, existing.longestStreak),
        lastActiveDate: toDateColumn(today),
      },
    });
  }

  /**
   * The user's IANA zone, falling back to UTC if the stored value is not one
   * Intl recognises. A bad profile value must not make completing a task fail:
   * the streak being wrong is recoverable, losing the completion is not.
   */
  private async timezoneFor(tx: Prisma.TransactionClient, userId: string): Promise<string> {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    const timezone = user?.timezone ?? 'UTC';

    try {
      localCalendarDate(new Date(), timezone);
      return timezone;
    } catch {
      this.logger.warn(`User ${userId} has unusable timezone "${timezone}"; treating as UTC`);
      return 'UTC';
    }
  }

  /**
   * Totals for GET /me/stats.
   *
   * totalXp is summed from the ledger on every read and level is derived from
   * it, so neither can drift from the events that produced them. There is no
   * balance column to go stale.
   */
  async getStats(userId: string): Promise<UserStats> {
    const [ledger, streak] = await Promise.all([
      this.prisma.xpEvent.aggregate({ where: { userId }, _sum: { xpAmount: true } }),
      this.prisma.streak.findUnique({ where: { userId } }),
    ]);

    const totalXp = ledger._sum.xpAmount ?? 0;

    return {
      totalXp,
      level: levelForXp(totalXp),
      currentStreak: streak?.currentStreak ?? 0,
      longestStreak: streak?.longestStreak ?? 0,
      lastActiveDate: streak?.lastActiveDate ? fromDateColumn(streak.lastActiveDate) : null,
    };
  }
}
