import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';
import { StreakFreezeService } from './streak-freeze.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

/** A streak row as the sweep reads it. Dates are DATE columns, anchored at UTC. */
const streak = (over: Record<string, unknown> = {}) => ({
  userId: USER_ID,
  freezes: 1,
  currentStreak: 5,
  lastActiveDate: new Date('2026-10-27T00:00:00.000Z'),
  user: { timezone: 'UTC' },
  ...over,
});

let findMany: ReturnType<typeof vi.fn>;
let updateMany: ReturnType<typeof vi.fn>;
let service: StreakFreezeService;

beforeEach(() => {
  findMany = vi.fn().mockResolvedValue([]);
  updateMany = vi.fn().mockResolvedValue({ count: 1 });

  service = new StreakFreezeService({
    streak: { findMany, updateMany },
  } as unknown as PrismaService);
});

describe('StreakFreezeService', () => {
  // 2026-10-29T12:00Z: "yesterday" is 2026-10-28 in UTC.
  const now = new Date('2026-10-29T12:00:00.000Z');

  it('spends one freeze for one missed day', async () => {
    findMany.mockResolvedValue([streak()]);

    const summary = await service.runSweep(now);

    expect(summary.spent).toBe(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        freezes: { gte: 1 },
        lastActiveDate: new Date('2026-10-27T00:00:00.000Z'),
      },
      data: {
        freezes: { decrement: 1 },
        lastActiveDate: new Date('2026-10-28T00:00:00.000Z'),
      },
    });
  });

  it('spends two when two days were missed and two are held', async () => {
    findMany.mockResolvedValue([
      streak({ freezes: 2, lastActiveDate: new Date('2026-10-26T00:00:00.000Z') }),
    ]);

    const summary = await service.runSweep(now);

    expect(summary.spent).toBe(2);
    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      data: { freezes: { decrement: 2 }, lastActiveDate: new Date('2026-10-28T00:00:00.000Z') },
    });
  });

  it('does nothing when the user was active yesterday', async () => {
    findMany.mockResolvedValue([streak({ lastActiveDate: new Date('2026-10-28T00:00:00.000Z') })]);

    const summary = await service.runSweep(now);

    expect(summary.spent).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('does nothing when the run is shorter than the floor', async () => {
    findMany.mockResolvedValue([streak({ currentStreak: 2 })]);

    // The query filters this, so the fake returns it anyway; the service must
    // still not spend for a two-day run.
    const summary = await service.runSweep(now);

    expect(summary.spent).toBe(0);
  });

  it('leaves the run to break when the gap is longer than the freezes held', async () => {
    findMany.mockResolvedValue([
      streak({ freezes: 1, lastActiveDate: new Date('2026-10-25T00:00:00.000Z') }),
    ]);

    const summary = await service.runSweep(now);

    expect(summary.spent).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('counts nothing when the conditional claim loses to a completion', async () => {
    findMany.mockResolvedValue([streak()]);
    updateMany.mockResolvedValue({ count: 0 });

    const summary = await service.runSweep(now);

    expect(summary.spent).toBe(0);
  });

  it('resolves yesterday on the user’s calendar, not the server’s', async () => {
    // 2026-10-29T12:00Z is already 2026-10-30 in Kiritimati (UTC+14), so the
    // missed day there is the 29th, not the 28th.
    findMany.mockResolvedValue([
      streak({
        user: { timezone: 'Pacific/Kiritimati' },
        lastActiveDate: new Date('2026-10-28T00:00:00.000Z'),
      }),
    ]);

    await service.runSweep(now);

    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      data: { lastActiveDate: new Date('2026-10-29T00:00:00.000Z') },
    });
  });
});
