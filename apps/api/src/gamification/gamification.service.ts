import type { BadgeKey, EarnedBadge, TaskPriority, UserStats } from '@adhd/shared';
import {
  BADGES,
  isBadgeKey,
  levelForXp,
  STREAK_BADGE_DAYS,
  XP_DRAFT_REVIEW,
  xpForCompletion,
} from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import {
  fromDateColumn,
  localCalendarDate,
  previousCalendarDate,
  toDateColumn,
} from '../common/calendar.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The once-only key for a completion payment: one task, one day of the
 * user's own calendar. Reopen-and-recomplete on the same day maps to the same
 * key and the ledger's unique index refuses it; the same task done again
 * tomorrow is a new key and pays again.
 */
export function completionAwardKey(taskId: string, calendarDate: string): string {
  return `task_complete:${taskId}:${calendarDate}`;
}

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
   * The transition guard lives in TasksService.update, where the previous
   * status is known. What this method adds is the once-per-day rule: a task
   * pays at most once per day of the user's own calendar, so complete →
   * reopen → complete is not an XP tap, while a task genuinely done again
   * tomorrow pays again. The rule is the database's (`@@unique([userId,
   * awardKey])`), not a read-then-write here.
   *
   * `skipDuplicates` is `ON CONFLICT DO NOTHING`, which matters inside a
   * transaction: a plain insert hitting the index would raise, and Postgres
   * aborts the whole transaction on any error — taking the task's completion
   * down with it. The completion is real either way; only the payment is not.
   */
  async awardForCompletion(tx: Prisma.TransactionClient, award: CompletionAward): Promise<void> {
    const xpAmount = xpForCompletion(award.priority);
    const timezone = await this.timezoneFor(tx, award.userId);
    const today = localCalendarDate(award.now, timezone);

    // Insert first, streak second: the atomicity test depends on a failure
    // between the two rolling the ledger row back too.
    await tx.xpEvent.createMany({
      data: [
        {
          userId: award.userId,
          taskId: award.taskId,
          type: 'task_complete',
          xpAmount,
          awardKey: completionAwardKey(award.taskId, today),
        },
      ],
      skipDuplicates: true,
    });

    // Every completion "earns" it; only the first one inserts a row.
    await this.awardBadge(tx, award.userId, 'first_task_done');

    await this.touchStreak(tx, award.userId, today);
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

    // Approve or reject alike, same as the XP: the badge rewards reviewing,
    // and paying more for a yes would teach the user to rubber-stamp.
    await this.awardBadge(tx, review.userId, 'first_suggestion_reviewed');
  }

  /**
   * Grants a badge at most once, inside the caller's transaction.
   *
   * `skipDuplicates` is `ON CONFLICT DO NOTHING` against the
   * `(user_id, badge_key)` unique index. A plain insert would raise on the
   * second earning, and Postgres aborts the whole transaction on any error —
   * which would take the completion or review that earned it down too. Same
   * reasoning, same mechanism, as the once-per-day XP key.
   */
  private async awardBadge(
    tx: Prisma.TransactionClient,
    userId: string,
    badgeKey: BadgeKey,
  ): Promise<void> {
    await tx.userBadge.createMany({ data: [{ userId, badgeKey }], skipDuplicates: true });
  }

  /** The badges a user has earned, oldest first. */
  async listBadges(userId: string): Promise<EarnedBadge[]> {
    const rows = await this.prisma.userBadge.findMany({
      where: { userId },
      orderBy: { awardedAt: 'asc' },
    });

    // A key no longer in BADGE_KEYS (a retired badge) is skipped rather than
    // served without a name: the shared definitions are the source of truth.
    return rows.flatMap((row) =>
      isBadgeKey(row.badgeKey)
        ? [{ ...BADGES[row.badgeKey], awardedAt: row.awardedAt.toISOString() }]
        : [],
    );
  }

  /**
   * Advances the user's streak for a completion on `today` (their calendar).
   *
   * Three cases, all decided in the user's own timezone: another completion on
   * a day already counted changes nothing, a completion the day after the last
   * one extends the run, and anything further back starts a new run at 1.
   */
  private async touchStreak(
    tx: Prisma.TransactionClient,
    userId: string,
    today: string,
  ): Promise<void> {
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

    if (currentStreak >= STREAK_BADGE_DAYS) {
      await this.awardBadge(tx, userId, 'streak_3');
    }
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
