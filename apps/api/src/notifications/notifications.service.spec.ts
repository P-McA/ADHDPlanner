import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';
import { dedupeKeyFor, NotificationsService } from './notifications.service.js';
import type { PushMessage, PushReceipt, PushSender } from './notifications.ports.js';
import type { PushTokensService } from './push-tokens.service.js';

/**
 * The sweep's query shapes and the claim's failure handling.
 *
 * Whether a notification actually goes out once is proved against Postgres in
 * `test/notifications.e2e-spec.ts` — the unique index is the guarantee, and a
 * mocked client would agree with whatever this service did. What is worth
 * asserting here is the part a passing e2e cannot distinguish: the exact
 * `where` clause the fence lives in, and what happens when the claim loses.
 */

class StubSender implements PushSender {
  readonly batches: PushMessage[][] = [];

  send(messages: PushMessage[]): Promise<PushReceipt[]> {
    this.batches.push(messages);

    return Promise.resolve(messages.map((m) => ({ token: m.token, ok: true })));
  }
}

/**
 * Only the fields this spec reads back. The service itself talks to Prisma's
 * real types — `prisma` is cast on the way in — so this shape constrains the
 * assertions below and nothing else.
 */
type DispatchUpdate = (args: {
  where: { id: bigint };
  data: { status: string; deliveredCount: number; error?: string };
}) => Promise<object>;

const uniqueViolation = (): unknown => Object.assign(new Error('Unique constraint'), { code: 'P2002' });

let prisma: {
  user: { findMany: ReturnType<typeof vi.fn> };
  task: { findMany: ReturnType<typeof vi.fn> };
  streak: { findUnique: ReturnType<typeof vi.fn> };
  pushToken: { findMany: ReturnType<typeof vi.fn> };
  notificationDispatch: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn<DispatchUpdate>>;
  };
};
let pushTokens: { pruneDeadTokens: ReturnType<typeof vi.fn<() => Promise<number>>> };
let sender: StubSender;
let service: NotificationsService;

/** 14:00 UTC — 15:00 in London, comfortably inside the notify window. */
const MIDDAY = new Date('2026-09-09T14:00:00.000Z');

beforeEach(() => {
  prisma = {
    user: {
      findMany: vi.fn().mockResolvedValue([{ id: 'user-1', timezone: 'Europe/London' }]),
    },
    task: { findMany: vi.fn().mockResolvedValue([]) },
    streak: { findUnique: vi.fn().mockResolvedValue(null) },
    pushToken: { findMany: vi.fn().mockResolvedValue([{ token: 'tok-1' }]) },
    notificationDispatch: {
      create: vi.fn().mockResolvedValue({ id: 1n }),
      update: vi.fn<DispatchUpdate>().mockResolvedValue({}),
    },
  };

  pushTokens = { pruneDeadTokens: vi.fn<() => Promise<number>>().mockResolvedValue(0) };
  sender = new StubSender();

  service = new NotificationsService(
    prisma as unknown as PrismaService,
    pushTokens as unknown as PushTokensService,
    sender,
  );
});

describe('dedupeKeyFor', () => {
  it('identifies a due reminder by kind, day and task', () => {
    expect(dedupeKeyFor('due_reminder', '2026-09-09', 'task-7')).toBe(
      'due_reminder:2026-09-09:task-7',
    );
  });

  it('identifies a streak nudge by kind and day, because there is no task', () => {
    // One non-null string, never a tuple with a nullable member: Postgres
    // treats NULLs as distinct in a unique index, so a null taskId would make
    // every nudge unique and the constraint would prevent nothing.
    expect(dedupeKeyFor('streak_nudge', '2026-09-09')).toBe('streak_nudge:2026-09-09');
    expect(dedupeKeyFor('streak_nudge', '2026-09-09')).not.toContain('undefined');
  });
});

describe('NotificationsService — who it looks at', () => {
  it('only considers users with a registered device', async () => {
    await service.runSweep(MIDDAY);

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pushTokens: { some: {} } } }),
    );
  });

  it('skips a user whose local clock is outside the notify window', async () => {
    await service.runSweep(new Date('2026-09-09T02:00:00.000Z'));

    expect(prisma.task.findMany).not.toHaveBeenCalled();
    expect(prisma.notificationDispatch.create).not.toHaveBeenCalled();
  });

  it('carries on after one user fails, so nobody behind them is silenced', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 'broken', timezone: 'Europe/London' },
      { id: 'fine', timezone: 'Europe/London' },
    ]);
    prisma.task.findMany
      .mockRejectedValueOnce(new Error('database hiccup'))
      .mockResolvedValue([{ id: 'task-1', title: 'Book the car in' }]);

    const summary = await service.runSweep(MIDDAY);

    expect(summary.usersConsidered).toBe(2);
    expect(sender.batches).toHaveLength(1);
  });
});

describe('NotificationsService — the due-reminder query', () => {
  it('asks only for unfinished tasks inside the user’s own day, drafts excluded', async () => {
    await service.runSweep(MIDDAY);

    const [args] = prisma.task.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];

    expect(args.where.userId).toBe('user-1');
    expect(args.where.status).toEqual({ in: ['pending', 'in_progress'] });
    // The fence, in the place it is easiest to forget. The predicate is the
    // pair, so an approved suggestion keeps its provenance and is still
    // reminded about.
    expect(args.where.NOT).toEqual({ source: 'ai_suggested', confirmedAt: null });

    const dueAt = args.where.dueAt as { gte: Date; lt: Date };
    // Half-open, and resolved in London: the day starts at 23:00 UTC the night
    // before, which is the whole reason this is not a UTC date comparison.
    expect(dueAt.gte.toISOString()).toBe('2026-09-08T23:00:00.000Z');
    expect(dueAt.lt.toISOString()).toBe('2026-09-09T23:00:00.000Z');
  });
});

describe('NotificationsService — the streak nudge', () => {
  const streak = (currentStreak: number, lastActiveDate: string | null) => ({
    currentStreak,
    lastActiveDate: lastActiveDate ? new Date(`${lastActiveDate}T00:00:00.000Z`) : null,
  });

  it('nudges a qualifying run that would break today', async () => {
    prisma.streak.findUnique.mockResolvedValue(streak(5, '2026-09-08'));

    await service.runSweep(MIDDAY);

    expect(prisma.notificationDispatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'streak_nudge',
          dedupeKey: 'streak_nudge:2026-09-09',
        }) as unknown,
      }),
    );
  });

  it.each([
    ['too short to be worth protecting', streak(2, '2026-09-08')],
    ['already extended today', streak(5, '2026-09-09')],
    ['already broken days ago', streak(12, '2026-09-04')],
    ['never started', streak(0, null)],
  ])('stays quiet on a run that is %s', async (_case, value) => {
    prisma.streak.findUnique.mockResolvedValue(value);

    await service.runSweep(MIDDAY);

    expect(prisma.notificationDispatch.create).not.toHaveBeenCalled();
  });
});

describe('NotificationsService — losing the claim', () => {
  it('sends nothing when the unique index says someone already claimed it', async () => {
    prisma.task.findMany.mockResolvedValue([{ id: 'task-1', title: 'Book the car in' }]);
    prisma.notificationDispatch.create.mockRejectedValue(uniqueViolation());

    const summary = await service.runSweep(MIDDAY);

    // The expected path for a repeated sweep, not an error path. This is the
    // whole of rider 2, seen from inside.
    expect(sender.batches).toHaveLength(0);
    expect(summary.alreadySent).toBe(1);
    expect(summary.claimed).toBe(0);
  });

  it('does not swallow a database error that is not a duplicate', async () => {
    prisma.task.findMany.mockResolvedValue([{ id: 'task-1', title: 'Book the car in' }]);
    prisma.notificationDispatch.create.mockRejectedValue(
      Object.assign(new Error('connection refused'), { code: 'P1001' }),
    );

    // Not treated as "already sent": that would turn an outage into permanent
    // silence with a clean-looking summary.
    const summary = await service.runSweep(MIDDAY);

    expect(summary.alreadySent).toBe(0);
    expect(summary.sent).toBe(0);
  });
});

describe('NotificationsService — after the send', () => {
  beforeEach(() => {
    prisma.task.findMany.mockResolvedValue([{ id: 'task-1', title: 'Book the car in' }]);
  });

  it('prunes dead tokens with the receipts, before writing the status', async () => {
    const order: string[] = [];
    pushTokens.pruneDeadTokens.mockImplementation(() => {
      order.push('prune');

      return Promise.resolve(0);
    });
    prisma.notificationDispatch.update.mockImplementation(() => {
      order.push('status');

      return Promise.resolve({});
    });

    await service.runSweep(MIDDAY);

    // Prune first, so a device the provider has just told us is gone stops
    // being sent to even if the status write fails.
    expect(order).toEqual(['prune', 'status']);
    expect(pushTokens.pruneDeadTokens).toHaveBeenCalledWith('user-1', [
      { token: 'tok-1', ok: true },
    ]);
  });

  it('marks the row failed, with the reason, when no device was reached', async () => {
    service = new NotificationsService(
      prisma as unknown as PrismaService,
      pushTokens as unknown as PushTokensService,
      {
        send: (messages) =>
          Promise.resolve(
            messages.map((m) => ({ token: m.token, ok: false, reason: 'transport' as const })),
          ),
      },
    );

    const summary = await service.runSweep(MIDDAY);

    expect(prisma.notificationDispatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', deliveredCount: 0 }) as unknown,
      }),
    );
    expect(summary.failed).toBe(1);
  });

  it('does not leave the row on `claimed` when the sender breaks its contract', async () => {
    service = new NotificationsService(
      prisma as unknown as PrismaService,
      pushTokens as unknown as PushTokensService,
      {
        send: () => {
          throw new Error('adapter is broken');
        },
      },
    );

    await expect(service.runSweep(MIDDAY)).resolves.toBeDefined();

    // `claimed` means in flight. Attached to something that will never land,
    // it is the one status that can never be resolved by looking again.
    const call = prisma.notificationDispatch.update.mock.calls[0];
    expect(call?.[0].data.status).toBe('failed');
  });
});
