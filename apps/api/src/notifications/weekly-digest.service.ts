import {
  localCalendarDate,
  localDayBoundsUtc,
  localHour,
  previousCalendarDate,
  toDateColumn,
  usableTimeZone,
} from '../common/calendar.js';
import {
  WEEKLY_DIGEST_HOUR,
  WEEKLY_DIGEST_WEEKDAY,
} from '@adhd/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { isUniqueViolation, summarise } from './notifications.service.js';
import { PUSH_SENDER, type PushReceipt, type PushSender } from './notifications.ports.js';
import { PushTokensService } from './push-tokens.service.js';

export interface DigestSweepSummary {
  /** Users with a device whose local clock was inside the digest hour. */
  considered: number;
  sent: number;
  failed: number;
  alreadySent: number;
}

/** The Monday of the week `calendarDate` falls in, as YYYY-MM-DD. */
export function mondayOf(calendarDate: string): string {
  const date = new Date(`${calendarDate}T00:00:00.000Z`);
  const weekday = date.getUTCDay(); // 0 Sunday … 6 Saturday
  const back = weekday === 0 ? 6 : weekday - 1;

  return new Date(date.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The weekly digest: a look back at the finished week, pushed on Monday
 * morning in the user's own zone.
 *
 * Read-only. It aggregates what the ledger and the task list already say and
 * sends one notification; nothing here writes a task or XP. The dispatch
 * ledger gives it the same once-per-week guarantee as a reminder, keyed on the
 * Monday of the week being summarised.
 *
 * A quiet week is still worth sending: "nothing finished, N waiting" is the
 * most useful nudge the app can give someone who has drifted, and staying
 * silent would make the absence feel like a judgement.
 */
@Injectable()
export class WeeklyDigestService {
  private readonly logger = new Logger(WeeklyDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushTokens: PushTokensService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
  ) {}

  async runSweep(now: Date = new Date()): Promise<DigestSweepSummary> {
    const summary: DigestSweepSummary = { considered: 0, sent: 0, failed: 0, alreadySent: 0 };

    const users = await this.prisma.user.findMany({
      where: { pushTokens: { some: {} } },
      select: { id: true, timezone: true },
      orderBy: { createdAt: 'asc' },
    });

    for (const user of users) {
      const timeZone = usableTimeZone(user.timezone);
      const today = localCalendarDate(now, timeZone);
      const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();

      if (weekday !== WEEKLY_DIGEST_WEEKDAY || localHour(now, timeZone) !== WEEKLY_DIGEST_HOUR) {
        continue;
      }

      summary.considered += 1;

      try {
        await this.digestUser(user.id, timeZone, today, summary);
      } catch (error: unknown) {
        this.logger.error(
          `Digest failed for ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return summary;
  }

  private async digestUser(
    userId: string,
    timeZone: string,
    today: string,
    summary: DigestSweepSummary,
  ): Promise<void> {
    const thisMonday = mondayOf(today);
    const lastMonday = previousCalendarDate(thisMonday);
    const { start } = localDayBoundsUtc(lastMonday, timeZone);
    const { start: end } = localDayBoundsUtc(thisMonday, timeZone);

    const dispatchId = await this.claim(userId, today, lastMonday);

    if (dispatchId === null) {
      summary.alreadySent += 1;

      return;
    }

    const [completed, ledger, open, streak] = await Promise.all([
      this.prisma.task.count({
        where: { userId, status: 'done', completedAt: { gte: start, lt: end } },
      }),
      this.prisma.xpEvent.aggregate({
        where: { userId, createdAt: { gte: start, lt: end } },
        _sum: { xpAmount: true },
      }),
      this.prisma.task.count({
        where: {
          userId,
          status: { in: ['pending', 'in_progress'] },
          NOT: { source: 'ai_suggested', confirmedAt: null },
        },
      }),
      this.prisma.streak.findUnique({ where: { userId }, select: { currentStreak: true } }),
    ]);

    const xp = ledger._sum.xpAmount ?? 0;
    const body =
      completed === 0
        ? `A quiet week. ${String(open)} task${open === 1 ? '' : 's'} waiting when you are ready.`
        : `You finished ${String(completed)} task${completed === 1 ? '' : 's'} and earned ${String(xp)} XP. ${String(open)} still open.`;

    const receipts = await this.deliver(userId, {
      title: streak?.currentStreak ? `Your week · ${String(streak.currentStreak)}-day streak` : 'Your week',
      body,
      data: { kind: 'weekly_digest' },
    });

    await this.pushTokens.pruneDeadTokens(userId, receipts);

    const delivered = receipts.filter((receipt) => receipt.ok).length;

    await this.prisma.notificationDispatch.update({
      where: { id: dispatchId },
      data:
        delivered > 0
          ? { status: 'sent', deliveredCount: delivered }
          : { status: 'failed', deliveredCount: 0, error: summarise(receipts) },
    });

    if (delivered > 0) {
      summary.sent += 1;
    } else {
      summary.failed += 1;
    }
  }

  private async claim(userId: string, today: string, weekStart: string): Promise<bigint | null> {
    try {
      const row = await this.prisma.notificationDispatch.create({
        data: {
          userId,
          kind: 'weekly_digest',
          dedupeKey: `weekly_digest:${weekStart}`,
          localDate: toDateColumn(today),
        },
        select: { id: true },
      });

      return row.id;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) return null;

      throw error;
    }
  }

  private async deliver(
    userId: string,
    notification: { title: string; body: string; data: Record<string, string> },
  ): Promise<PushReceipt[]> {
    const tokens = await this.prisma.pushToken.findMany({
      where: { userId },
      select: { token: true },
    });

    try {
      return await this.sender.send(tokens.map((row) => ({ token: row.token, ...notification })));
    } catch (error: unknown) {
      // The sender is contracted never to throw; this is belt and braces.
      const detail = error instanceof Error ? error.message : String(error);

      return tokens.map((row) => ({ token: row.token, ok: false, reason: 'transport', detail }));
    }
  }
}
