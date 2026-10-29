import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { PushSender } from './notifications.ports.js';
import type { PushTokensService } from './push-tokens.service.js';
import { mondayOf, WeeklyDigestService } from './weekly-digest.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

/** 2026-10-26 is a Monday; 09:00 UTC is inside the digest hour. */
const MONDAY_9AM = new Date('2026-10-26T09:00:00.000Z');

let findMany: ReturnType<typeof vi.fn>;
let taskCount: ReturnType<typeof vi.fn>;
let aggregate: ReturnType<typeof vi.fn>;
let streakFind: ReturnType<typeof vi.fn>;
let dispatchCreate: ReturnType<typeof vi.fn>;
let dispatchUpdate: ReturnType<typeof vi.fn>;
let pushTokenFind: ReturnType<typeof vi.fn>;
let pruneDeadTokens: ReturnType<typeof vi.fn>;
let send: Mock<PushSender['send']>;
let service: WeeklyDigestService;

beforeEach(() => {
  findMany = vi.fn().mockResolvedValue([{ id: USER_ID, timezone: 'UTC' }]);
  taskCount = vi.fn().mockResolvedValue(0);
  aggregate = vi.fn().mockResolvedValue({ _sum: { xpAmount: 0 } });
  streakFind = vi.fn().mockResolvedValue(null);
  dispatchCreate = vi.fn().mockResolvedValue({ id: 1n });
  dispatchUpdate = vi.fn().mockResolvedValue({});
  pushTokenFind = vi.fn().mockResolvedValue([{ token: 'ExponentPushToken[a]' }]);
  pruneDeadTokens = vi.fn().mockResolvedValue(undefined);
  send = vi.fn<PushSender['send']>(() =>
    Promise.resolve([{ token: 'ExponentPushToken[a]', ok: true }]),
  );

  service = new WeeklyDigestService(
    {
      user: { findMany },
      task: { count: taskCount },
      xpEvent: { aggregate },
      streak: { findUnique: streakFind },
      notificationDispatch: { create: dispatchCreate, update: dispatchUpdate },
      pushToken: { findMany: pushTokenFind },
    } as unknown as PrismaService,
    { pruneDeadTokens } as unknown as PushTokensService,
    { send },
  );
});

describe('mondayOf', () => {
  it('returns the Monday of the week, including from a Sunday', () => {
    expect(mondayOf('2026-10-26')).toBe('2026-10-26');
    expect(mondayOf('2026-10-28')).toBe('2026-10-26');
    expect(mondayOf('2026-11-01')).toBe('2026-10-26');
  });
});

describe('WeeklyDigestService', () => {
  it('sends a digest on Monday morning', async () => {
    taskCount.mockResolvedValueOnce(4).mockResolvedValueOnce(2);
    aggregate.mockResolvedValue({ _sum: { xpAmount: 40 } });
    streakFind.mockResolvedValue({ currentStreak: 6 });

    const summary = await service.runSweep(MONDAY_9AM);

    expect(summary.sent).toBe(1);
    expect(send).toHaveBeenCalledWith([
      expect.objectContaining({
        title: 'Your week · 6-day streak',
        body: 'You finished 4 tasks and earned 40 XP. 2 still open.',
      }),
    ]);
  });

  it('still sends a quiet week, because silence reads as a judgement', async () => {
    taskCount.mockResolvedValueOnce(0).mockResolvedValueOnce(3);

    await service.runSweep(MONDAY_9AM);

    expect(send.mock.calls[0]![0][0]!.body).toContain('A quiet week');
    expect(send.mock.calls[0]![0][0]!.body).toContain('3 tasks waiting');
  });

  it('does nothing on another weekday', async () => {
    const summary = await service.runSweep(new Date('2026-10-27T09:00:00.000Z'));

    expect(summary.considered).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing outside the digest hour', async () => {
    const summary = await service.runSweep(new Date('2026-10-26T10:00:00.000Z'));

    expect(summary.considered).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send twice for the same week', async () => {
    dispatchCreate.mockRejectedValue({ code: 'P2002' });

    const summary = await service.runSweep(MONDAY_9AM);

    expect(summary.alreadySent).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('decides Monday on the user’s calendar, not the server’s', async () => {
    // 2026-10-25T20:00Z is already Monday 10:00 in Kiritimati (UTC+14), so
    // the digest hour there is 10:00, not 09:00 — use 19:00Z for 09:00 local.
    findMany.mockResolvedValue([{ id: USER_ID, timezone: 'Pacific/Kiritimati' }]);

    const summary = await service.runSweep(new Date('2026-10-25T19:00:00.000Z'));

    expect(summary.sent).toBe(1);
  });

  it('records a failed dispatch when no device accepted it', async () => {
    send.mockResolvedValue([{ token: 'ExponentPushToken[a]', ok: false, reason: 'transport' }]);

    const summary = await service.runSweep(MONDAY_9AM);

    expect(summary.failed).toBe(1);
    const [{ data }] = dispatchUpdate.mock.calls[0] as [{ data: { status: string } }];

    expect(data.status).toBe('failed');
  });
});
