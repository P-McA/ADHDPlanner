import {
  DUE_REMINDER_MAX_PER_SWEEP,
  type NotificationKind,
  REMINDER_WINDOW_END_HOUR,
  REMINDER_WINDOW_START_HOUR,
  STREAK_NUDGE_MIN_DAYS,
} from '@adhd/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  fromDateColumn,
  localCalendarDate,
  localDayBoundsUtc,
  localHour,
  previousCalendarDate,
  toDateColumn,
  usableTimeZone,
} from '../common/calendar.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PUSH_SENDER, type PushReceipt, type PushSender } from './notifications.ports.js';
import { PushTokensService } from './push-tokens.service.js';

/** What one sweep did, for the log line and for the tests to assert on. */
export interface SweepSummary {
  /** Users with at least one registered device, inside their notify window. */
  usersConsidered: number;
  /** Dispatch rows written by this run. */
  claimed: number;
  /** Claims that reached at least one device. */
  sent: number;
  /** Claims that reached none. The reason is on the row. */
  failed: number;
  /** Notifications this run declined to repeat, because a claim already existed. */
  alreadySent: number;
}

/**
 * The dedupe key for one notification, within one user.
 *
 * A single non-null string, not a (kind, date, taskId) tuple, and the reason is
 * in the schema: Postgres treats NULLs as distinct in a unique index, so the
 * streak nudge's absent taskId would make every nudge unique and the constraint
 * would prevent nothing.
 */
export function dedupeKeyFor(
  kind: NotificationKind,
  calendarDate: string,
  taskId?: string,
): string {
  return taskId ? `${kind}:${calendarDate}:${taskId}` : `${kind}:${calendarDate}`;
}

/** One notification, before it is addressed to any particular device. */
interface Notification {
  kind: NotificationKind;
  dedupeKey: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushTokens: PushTokensService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
  ) {}

  /**
   * One pass over everyone who could be notified.
   *
   * `now` is injected rather than read from the clock so a test can put a user
   * at 09:00 in Sydney and 20:00 in Los Angeles in the same run, which is the
   * only way to check the window and the local-date logic at all.
   *
   * **Never throws.** One user's bad data must not silence everybody after them
   * in the loop — the same reason `AudioIngestionProcessor` swallows provider
   * failures onto the record. Failures land on the dispatch row and in the log.
   */
  async runSweep(now: Date = new Date()): Promise<SweepSummary> {
    const summary: SweepSummary = {
      usersConsidered: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      alreadySent: 0,
    };

    // Only users with a device: everyone else has nothing this sweep could do,
    // and claiming for them would burn the day's dedupe key on a notification
    // that was never sent — so registering a phone at lunchtime would produce
    // silence until tomorrow.
    const users = await this.prisma.user.findMany({
      where: { pushTokens: { some: {} } },
      select: { id: true, timezone: true },
      orderBy: { createdAt: 'asc' },
    });

    for (const user of users) {
      const timeZone = usableTimeZone(user.timezone);
      const hour = localHour(now, timeZone);

      if (hour < REMINDER_WINDOW_START_HOUR || hour >= REMINDER_WINDOW_END_HOUR) {
        continue;
      }

      summary.usersConsidered += 1;

      try {
        await this.sweepUser(user.id, timeZone, now, summary);
      } catch (error: unknown) {
        this.logger.error(
          `Sweep failed for user ${user.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(
      `Sweep: ${String(summary.usersConsidered)} user(s), ${String(summary.sent)} sent, ` +
        `${String(summary.failed)} failed, ${String(summary.alreadySent)} already sent`,
    );

    return summary;
  }

  private async sweepUser(
    userId: string,
    timeZone: string,
    now: Date,
    summary: SweepSummary,
  ): Promise<void> {
    const today = localCalendarDate(now, timeZone);

    const nudge = await this.streakNudge(userId, timeZone, today);
    if (nudge) {
      await this.dispatch(userId, today, nudge, summary);
    }

    let sentThisSweep = 0;

    for (const reminder of await this.dueReminders(userId, timeZone, today)) {
      if (sentThisSweep >= DUE_REMINDER_MAX_PER_SWEEP) {
        break;
      }

      // Only a notification this run actually claimed counts against the cap.
      // One already claimed cost the user nothing today, so letting it consume
      // a slot would hold back the next task for no reason.
      if (await this.dispatch(userId, today, reminder, summary)) {
        sentThisSweep += 1;
      }
    }
  }

  /**
   * Tasks due today, in the user's own day, that are not finished.
   *
   * `due_at` is a `timestamptz` and "today" is a local calendar day, so the
   * conversion happens once here — the query stays an indexed range scan
   * instead of a per-row timezone conversion no index can help.
   *
   * The `NOT` clause is the draft fence, in the one place it would be easiest
   * to forget: an unconfirmed AI suggestion is not yet the user's task, and
   * pushing a notification about something the user has never agreed to would
   * be the app auto-creating work by the back door. Approved suggestions keep
   * their provenance and are reminded about like anything else, which is why
   * the predicate is the pair and not `source` alone.
   */
  private async dueReminders(
    userId: string,
    timeZone: string,
    today: string,
  ): Promise<Notification[]> {
    const { start, end } = localDayBoundsUtc(today, timeZone);

    const tasks = await this.prisma.task.findMany({
      where: {
        userId,
        dueAt: { gte: start, lt: end },
        status: { in: ['pending', 'in_progress'] },
        NOT: { source: 'ai_suggested', confirmedAt: null },
      },
      select: { id: true, title: true },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    });

    return tasks.map((task) => ({
      kind: 'due_reminder' as const,
      dedupeKey: dedupeKeyFor('due_reminder', today, task.id),
      title: 'Due today',
      body: task.title,
      data: { kind: 'due_reminder', taskId: task.id },
    }));
  }

  /**
   * The nudge for a run that is alive and would break tonight.
   *
   * Two conditions, and the second is the one that is easy to get wrong.
   * `currentStreak >= STREAK_NUDGE_MIN_DAYS` is the "worth protecting" test.
   * `lastActiveDate === yesterday` is the "still alive" test: `currentStreak`
   * is not recomputed until the next completion, so a 12-day run last touched
   * five days ago still reads as 12. Nudging on that would tell the user they
   * are about to lose something they lost last Tuesday — and the app would be
   * lying about the one number it asks them to care about.
   *
   * "No completion today" is then implied rather than checked separately: a
   * completion today would have moved `lastActiveDate` to today.
   */
  private async streakNudge(
    userId: string,
    timeZone: string,
    today: string,
  ): Promise<Notification | null> {
    const streak = await this.prisma.streak.findUnique({ where: { userId } });

    if (!streak?.lastActiveDate || streak.currentStreak < STREAK_NUDGE_MIN_DAYS) {
      return null;
    }

    if (fromDateColumn(streak.lastActiveDate) !== previousCalendarDate(today)) {
      return null;
    }

    const days = String(streak.currentStreak);

    return {
      kind: 'streak_nudge',
      dedupeKey: dedupeKeyFor('streak_nudge', today),
      title: `${days}-day streak`,
      body: `Finish one thing today to keep your ${days}-day streak going.`,
      data: { kind: 'streak_nudge' },
    };
  }

  /**
   * Claim, then send. Returns whether this run claimed it.
   *
   * The order is the entire idempotency guarantee and it is the unusual way
   * round on purpose. Sending first and recording after leaves a window — a
   * crash, a BullMQ retry, two sweeps overlapping — in which the same reminder
   * goes out twice. Claiming first closes that window at a stated cost: if the
   * provider is down, the claim survives the failure and the notification is
   * lost for the day rather than retried. That trade is right for a channel the
   * user cannot mute per-message. A duplicate is the failure people notice, and
   * the one that gets notifications turned off for good.
   *
   * The loss is never silent: the row carries `failed` and the provider's own
   * words, so "why did I not get my reminder" has an answer in the database.
   */
  private async dispatch(
    userId: string,
    today: string,
    notification: Notification,
    summary: SweepSummary,
  ): Promise<boolean> {
    const dispatchId = await this.claim(userId, today, notification);

    if (dispatchId === null) {
      summary.alreadySent += 1;

      return false;
    }

    summary.claimed += 1;

    const tokens = await this.prisma.pushToken.findMany({
      where: { userId },
      select: { token: true },
    });

    const receipts = await this.deliver(
      tokens.map((row) => row.token),
      notification,
    );

    // Before the status write, so a device the provider has just told us is
    // gone stops being sent to even if the update below fails.
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

    return true;
  }

  /**
   * Writes the claim, or reports that someone already holds it.
   *
   * The `@@unique([userId, dedupeKey])` violation is the expected path, not an
   * error path: it is what a repeated sweep looks like. Reading first and then
   * inserting would be the same race this exists to close, so the database
   * decides.
   */
  private async claim(
    userId: string,
    today: string,
    notification: Notification,
  ): Promise<bigint | null> {
    try {
      const row = await this.prisma.notificationDispatch.create({
        data: {
          userId,
          kind: notification.kind,
          dedupeKey: notification.dedupeKey,
          localDate: toDateColumn(today),
        },
        select: { id: true },
      });

      return row.id;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return null;
      }

      throw error;
    }
  }

  /**
   * Hands the batch to the provider.
   *
   * `PushSender.send` is contracted never to throw, and this catches anyway.
   * The contract is a promise made by an adapter; the dispatch ledger's
   * correctness should not rest on one being kept. Without this, an adapter bug
   * would leave the row on `claimed` for ever — the one status that means
   * "in flight", attached to something that will never land.
   */
  private async deliver(tokens: string[], notification: Notification): Promise<PushReceipt[]> {
    if (tokens.length === 0) {
      // The user's last device was deregistered between the sweep's user query
      // and here, most likely by pruning during this same run.
      return [];
    }

    const messages = tokens.map((token) => ({
      token,
      title: notification.title,
      body: notification.body,
      data: notification.data,
    }));

    try {
      return await this.sender.send(messages);
    } catch (error: unknown) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

      this.logger.error(`Push sender threw, which its contract forbids: ${detail}`);

      return messages.map((message) => ({
        token: message.token,
        ok: false,
        reason: 'transport' as const,
        detail,
      }));
    }
  }
}

/** The provider's reasons, deduplicated, for the dispatch row's `error`. */
function summarise(receipts: PushReceipt[]): string {
  if (receipts.length === 0) {
    return 'no registered devices';
  }

  const reasons = [...new Set(receipts.map((receipt) => receipt.reason ?? 'unknown'))];

  return `no device reached (${reasons.join(', ')})`;
}

/**
 * Whether an error is Postgres' unique-constraint violation, as Prisma reports
 * it.
 *
 * Structural rather than `instanceof PrismaClientKnownRequestError`: this
 * package compiles as node16 ESM against a generated client, and an identity
 * check that silently stops matching would turn every repeated sweep into a
 * 500 — the failure mode is a duplicate notification, which is exactly what
 * this code exists to prevent.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
