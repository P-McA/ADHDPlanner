import { describe, expect, it } from 'vitest';

import { calendarDaysBetween, compareRanked, rankTask, type RankInput } from './priority.js';

const input = (over: Partial<RankInput> = {}): RankInput => ({
  dueInDays: null,
  priority: 'med',
  estimateMinutes: null,
  ...over,
});

describe('rankTask', () => {
  it('puts an overdue task above one due today, above tomorrow, above this week, above later', () => {
    const scores = [-3, 0, 1, 5, 30].map((dueInDays) => rankTask(input({ dueInDays })).score);

    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(new Set(scores).size).toBe(scores.length);
  });

  it('ranks a task with no due date below one due later, all else equal', () => {
    expect(rankTask(input({ dueInDays: 30 })).score).toBeGreaterThan(rankTask(input()).score);
  });

  it('lets manual priority order tasks due on the same day', () => {
    const order = (['urgent', 'high', 'med', 'low'] as const).map(
      (priority) => rankTask(input({ dueInDays: 2, priority })).score,
    );

    expect([...order].sort((a, b) => b - a)).toEqual(order);
    expect(new Set(order).size).toBe(4);
  });

  it('never lets priority alone lift an undated task above an overdue one', () => {
    // The due date is the part of the score that is a fact about the world;
    // "urgent" is the user's feeling about it. Overdue must still win.
    expect(rankTask(input({ dueInDays: -1, priority: 'low' })).score).toBeGreaterThan(
      rankTask(input({ priority: 'urgent' })).score,
    );
  });

  it('gives a short task a boost — a quick win — but less than a day of urgency', () => {
    const quick = rankTask(input({ dueInDays: 1, estimateMinutes: 5 })).score;
    const plain = rankTask(input({ dueInDays: 1 })).score;
    const dueToday = rankTask(input({ dueInDays: 0 })).score;

    expect(quick).toBeGreaterThan(plain);
    expect(dueToday).toBeGreaterThan(quick);
  });

  it('gives no boost to a long task, or to one with no estimate', () => {
    const base = rankTask(input()).score;

    expect(rankTask(input({ estimateMinutes: 120 })).score).toBe(base);
    expect(rankTask(input({ estimateMinutes: null })).score).toBe(base);
  });

  describe('reasons', () => {
    it.each([
      [-2, 'Overdue'],
      [0, 'Due today'],
      [1, 'Due tomorrow'],
      [4, 'Due this week'],
    ] as const)('says when it is due (%i days → %s)', (dueInDays, reason) => {
      expect(rankTask(input({ dueInDays })).reasons).toContain(reason);
    });

    it('names a high or urgent priority, and says nothing about med or low', () => {
      expect(rankTask(input({ priority: 'urgent' })).reasons).toContain('Urgent');
      expect(rankTask(input({ priority: 'high' })).reasons).toContain('High priority');
      expect(rankTask(input({ priority: 'med' })).reasons).toEqual([]);
      expect(rankTask(input({ priority: 'low' })).reasons).toEqual([]);
    });

    it('calls a short task a quick win, with its estimate', () => {
      expect(rankTask(input({ estimateMinutes: 15 })).reasons).toContain('Quick win · ~15 min');
    });

    it('says nothing for a task that is not notable, rather than inventing a reason', () => {
      expect(rankTask(input({ dueInDays: 30 })).reasons).toEqual([]);
    });

    it('lists the reasons in the order they count: when, then priority, then size', () => {
      expect(
        rankTask(input({ dueInDays: 0, priority: 'high', estimateMinutes: 5 })).reasons,
      ).toEqual(['Due today', 'High priority', 'Quick win · ~5 min']);
    });
  });
});

describe('compareRanked', () => {
  it('orders by score, highest first, then by id so the order is total', () => {
    const rows = [
      { id: 'b', score: 10 },
      { id: 'a', score: 10 },
      { id: 'c', score: 50 },
    ];

    expect([...rows].sort(compareRanked).map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('calendarDaysBetween', () => {
  it('counts whole calendar days, negative backwards, across a month and a clock change', () => {
    expect(calendarDaysBetween('2026-10-09', '2026-10-09')).toBe(0);
    expect(calendarDaysBetween('2026-10-09', '2026-10-10')).toBe(1);
    expect(calendarDaysBetween('2026-10-09', '2026-10-06')).toBe(-3);
    expect(calendarDaysBetween('2026-10-30', '2026-11-02')).toBe(3);
  });
});
