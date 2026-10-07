import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../prisma/prisma.service.js';
import { completionAwardKey, GamificationService } from './gamification.service.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const TASK_ID = '22222222-2222-2222-2222-222222222222';

/** A DATE column comes back from Prisma anchored at UTC midnight. */
const dateColumn = (calendarDate: string): Date => new Date(`${calendarDate}T00:00:00.000Z`);

describe('GamificationService', () => {
  let service: GamificationService;

  let tx: {
    xpEvent: { createMany: ReturnType<typeof vi.fn> };
    streak: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    user: { findUnique: ReturnType<typeof vi.fn> };
  };

  let prisma: {
    xpEvent: { aggregate: ReturnType<typeof vi.fn> };
    streak: { findUnique: ReturnType<typeof vi.fn> };
  };

  /** The mocked transaction client, in the shape the service expects. */
  const asTx = (): Prisma.TransactionClient => tx as unknown as Prisma.TransactionClient;

  /** Sets the timezone the user row will report. */
  const withTimezone = (timezone: string): void => {
    tx.user.findUnique.mockResolvedValue({ timezone });
  };

  /** Awards for a completion at `now`, at medium priority unless stated. */
  const award = async (
    now: Date,
    priority: 'low' | 'med' | 'high' | 'urgent' = 'med',
  ): Promise<void> =>
    service.awardForCompletion(asTx(), { userId: USER_ID, taskId: TASK_ID, priority, now });

  beforeEach(async () => {
    tx = {
      xpEvent: { createMany: vi.fn() },
      streak: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn(), update: vi.fn() },
      user: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    };
    prisma = {
      xpEvent: { aggregate: vi.fn() },
      streak: { findUnique: vi.fn().mockResolvedValue(null) },
    };

    const moduleRef = await Test.createTestingModule({ providers: [GamificationService] })
      .useMocker((token) => (token === PrismaService ? prisma : undefined))
      .compile();

    service = moduleRef.get(GamificationService);
  });

  /** The `data` payload of the first streak update call. */
  const streakUpdateData = (): Record<string, unknown> => {
    const call = tx.streak.update.mock.calls[0] as [{ data: Record<string, unknown> }];
    return call[0].data;
  };

  /** The `create` payload of the first streak upsert call. */
  const streakUpsertCreate = (): Record<string, unknown> => {
    const call = tx.streak.upsert.mock.calls[0] as [{ create: Record<string, unknown> }];
    return call[0].create;
  };

  describe('XP amounts', () => {
    it.each([
      ['low', 10],
      ['med', 10],
      ['high', 13],
      ['urgent', 15],
    ] as const)('pays %s priority %i XP', async (priority, expected) => {
      await award(new Date('2026-05-01T12:00:00Z'), priority);

      expect(tx.xpEvent.createMany).toHaveBeenCalledWith({
        data: [
          {
            userId: USER_ID,
            taskId: TASK_ID,
            type: 'task_complete',
            xpAmount: expected,
            awardKey: expect.stringMatching(/^task_complete:/) as string,
          },
        ],
        // ON CONFLICT DO NOTHING: a second payment the same day must be a
        // no-op, not an error that aborts the transaction and the completion.
        skipDuplicates: true,
      });
    });

    it('writes the ledger row before touching the streak', async () => {
      // Ordering is load-bearing: the atomicity guarantee is that a streak
      // failure rolls the ledger row back, which requires the insert first.
      const order: string[] = [];
      tx.xpEvent.createMany.mockImplementation(() => {
        order.push('xp');
      });
      tx.streak.upsert.mockImplementation(() => {
        order.push('streak');
      });

      await award(new Date('2026-05-01T12:00:00Z'));

      expect(order).toEqual(['xp', 'streak']);
    });
  });

  describe('streaks', () => {
    it('starts a streak at 1 on the first ever completion', async () => {
      tx.streak.findUnique.mockResolvedValue(null);

      await award(new Date('2026-05-01T12:00:00Z'));

      expect(tx.streak.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: {
            userId: USER_ID,
            currentStreak: 1,
            longestStreak: 1,
            lastActiveDate: dateColumn('2026-05-01'),
          },
        }),
      );
    });

    it('is a no-op for a second completion the same day', async () => {
      tx.streak.findUnique.mockResolvedValue({
        userId: USER_ID,
        currentStreak: 3,
        longestStreak: 7,
        lastActiveDate: dateColumn('2026-05-01'),
      });

      await award(new Date('2026-05-01T23:00:00Z'));

      // Five tasks in an afternoon is one day of the habit, not five.
      expect(tx.streak.update).not.toHaveBeenCalled();
      expect(tx.streak.upsert).not.toHaveBeenCalled();
      // The XP still pays, though — only the streak is once-daily.
      expect(tx.xpEvent.createMany).toHaveBeenCalledOnce();
    });

    it('increments on a completion the day after the last one', async () => {
      tx.streak.findUnique.mockResolvedValue({
        userId: USER_ID,
        currentStreak: 3,
        longestStreak: 7,
        lastActiveDate: dateColumn('2026-05-01'),
      });

      await award(new Date('2026-05-02T09:00:00Z'));

      expect(tx.streak.update).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        data: {
          currentStreak: 4,
          longestStreak: 7,
          lastActiveDate: dateColumn('2026-05-02'),
        },
      });
    });

    it('resets to 1 after a gap, keeping the longest run', async () => {
      tx.streak.findUnique.mockResolvedValue({
        userId: USER_ID,
        currentStreak: 9,
        longestStreak: 9,
        lastActiveDate: dateColumn('2026-05-01'),
      });

      await award(new Date('2026-05-04T09:00:00Z'));

      expect(tx.streak.update).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        data: {
          currentStreak: 1,
          longestStreak: 9,
          lastActiveDate: dateColumn('2026-05-04'),
        },
      });
    });

    it('raises the longest run when the current one passes it', async () => {
      tx.streak.findUnique.mockResolvedValue({
        userId: USER_ID,
        currentStreak: 7,
        longestStreak: 7,
        lastActiveDate: dateColumn('2026-05-01'),
      });

      await award(new Date('2026-05-02T09:00:00Z'));

      expect(streakUpdateData()).toMatchObject({ currentStreak: 8, longestStreak: 8 });
    });
  });

  describe('day boundaries use the user timezone, not server time', () => {
    // 2026-05-02T02:00Z is still 2026-05-01 at 22:00 in New York. Server time
    // and user time disagree about which day this is, and the user wins.
    const lateEveningInNewYork = new Date('2026-05-02T02:00:00Z');

    it('treats 22:00 EDT as the same day when UTC has already rolled over', async () => {
      withTimezone('America/New_York');
      tx.streak.findUnique.mockResolvedValue({
        userId: USER_ID,
        currentStreak: 4,
        longestStreak: 4,
        lastActiveDate: dateColumn('2026-05-01'),
      });

      await award(lateEveningInNewYork);

      // Using server time here would have read this as 2026-05-02 and wrongly
      // incremented the streak for what is, to the user, still Friday evening.
      expect(tx.streak.update).not.toHaveBeenCalled();
      expect(tx.streak.upsert).not.toHaveBeenCalled();
    });

    it('counts the same instant as consecutive when the previous day was theirs', async () => {
      withTimezone('America/New_York');
      tx.streak.findUnique.mockResolvedValue({
        userId: USER_ID,
        currentStreak: 4,
        longestStreak: 4,
        lastActiveDate: dateColumn('2026-04-30'),
      });

      await award(lateEveningInNewYork);

      expect(streakUpdateData()).toMatchObject({
        currentStreak: 5,
        lastActiveDate: dateColumn('2026-05-01'),
      });
    });

    it('credits the same instant to a different day for a user ahead of UTC', async () => {
      // 2026-05-01T22:00Z is already 2026-05-02 in Tokyo.
      withTimezone('Asia/Tokyo');
      tx.streak.findUnique.mockResolvedValue(null);

      await award(new Date('2026-05-01T22:00:00Z'));

      expect(streakUpsertCreate()).toMatchObject({ lastActiveDate: dateColumn('2026-05-02') });
    });

    it('falls back to UTC when the stored timezone is not a real zone', async () => {
      withTimezone('Mars/Olympus_Mons');
      tx.streak.findUnique.mockResolvedValue(null);

      await award(new Date('2026-05-01T22:00:00Z'));

      // Losing the completion would be worse than crediting it to the wrong
      // day, so a bad profile value degrades rather than throws.
      expect(streakUpsertCreate()).toMatchObject({ lastActiveDate: dateColumn('2026-05-01') });
    });
  });

  describe('once-per-day completion key', () => {
    const keyFor = (): unknown =>
      (tx.xpEvent.createMany.mock.calls[0]?.[0] as { data: { awardKey: string }[] }).data[0]
        ?.awardKey;

    it("names the task and the user's own calendar day", async () => {
      withTimezone('America/New_York');
      // 02:00 UTC on 3 May is still 2 May in New York.
      await award(new Date('2026-05-03T02:00:00Z'));

      expect(keyFor()).toBe(`task_complete:${TASK_ID}:2026-05-02`);
      expect(completionAwardKey(TASK_ID, '2026-05-02')).toBe(keyFor());
    });

    it('gives the same task a new key on the next day, so a daily habit pays daily', async () => {
      await award(new Date('2026-05-02T12:00:00Z'));
      await award(new Date('2026-05-03T12:00:00Z'));

      const keys = tx.xpEvent.createMany.mock.calls.map(
        ([args]) => (args as { data: { awardKey: string }[] }).data[0]?.awardKey,
      );
      expect(keys).toEqual([
        `task_complete:${TASK_ID}:2026-05-02`,
        `task_complete:${TASK_ID}:2026-05-03`,
      ]);
    });
  });

  describe('getStats', () => {
    const withLedger = (totalXp: number | null): void => {
      prisma.xpEvent.aggregate.mockResolvedValue({ _sum: { xpAmount: totalXp } });
    };

    it.each([
      [0, 1],
      [99, 1],
      [100, 2],
      [250, 3],
    ])('reports %i XP as level %i', async (totalXp, level) => {
      withLedger(totalXp);

      const stats = await service.getStats(USER_ID);

      expect(stats.totalXp).toBe(totalXp);
      expect(stats.level).toBe(level);
    });

    it('reports zero for a user with no ledger rows at all', async () => {
      // SUM over no rows is NULL, not 0.
      withLedger(null);

      await expect(service.getStats(USER_ID)).resolves.toEqual({
        totalXp: 0,
        level: 1,
        currentStreak: 0,
        longestStreak: 0,
        lastActiveDate: null,
      });
    });

    it('reads the streak from its row and the total from the ledger', async () => {
      withLedger(140);
      prisma.streak.findUnique.mockResolvedValue({
        currentStreak: 5,
        longestStreak: 11,
        lastActiveDate: dateColumn('2026-05-02'),
      });

      await expect(service.getStats(USER_ID)).resolves.toEqual({
        totalXp: 140,
        level: 2,
        currentStreak: 5,
        longestStreak: 11,
        lastActiveDate: '2026-05-02',
      });
    });

    it('scopes both reads to the requested user', async () => {
      withLedger(10);

      await service.getStats(USER_ID);

      expect(prisma.xpEvent.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER_ID } }),
      );
      expect(prisma.streak.findUnique).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    });
  });
});
