import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_DIRECTIONS,
  BASELINE_MIN_SAMPLES,
  comparisonFor,
  complexityForTask,
  eloTone,
  FORMULA_VERSION,
  LEVEL_BAND,
  performanceScore,
  PRIORITY_DEFAULT_MINUTES,
  SCORE_MAX,
  SPEED_MAX,
  SPEED_MIN,
  speedFactorForCompletion,
  TRACKING_MODES,
} from './activity.js';
import type { TaskPriority } from './task.js';

const at = (iso: string): Date => new Date(iso);

const completion = (over: Partial<Parameters<typeof performanceScore>[0]> = {}) => ({
  priority: 'med' as TaskPriority,
  estimateMinutes: null,
  isStep: false,
  childStepCount: 0,
  createdAt: at('2026-10-29T09:00:00.000Z'),
  startedAt: at('2026-10-29T09:00:00.000Z'),
  completedAt: at('2026-10-29T09:20:00.000Z'),
  ...over,
});

describe('tracking modes', () => {
  it('offers exactly metrics and xp, with metrics the adult default', () => {
    expect(TRACKING_MODES).toEqual(['metrics', 'xp']);
  });
});

describe('complexityForTask', () => {
  it('ranks priority low < med < high < urgent', () => {
    const scores = (['low', 'med', 'high', 'urgent'] as const).map((priority) =>
      complexityForTask({ priority, estimateMinutes: null, isStep: false, childStepCount: 0 }),
    );

    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    expect(new Set(scores).size).toBe(4);
  });

  it('makes a longer estimate more complex', () => {
    const short = complexityForTask({
      priority: 'med',
      estimateMinutes: 5,
      isStep: false,
      childStepCount: 0,
    });
    const long = complexityForTask({
      priority: 'med',
      estimateMinutes: 240,
      isStep: false,
      childStepCount: 0,
    });

    expect(long).toBeGreaterThan(short);
  });

  it('treats an unestimated task like the shortest bucket rather than inventing complexity', () => {
    const none = complexityForTask({
      priority: 'med',
      estimateMinutes: null,
      isStep: false,
      childStepCount: 0,
    });
    const five = complexityForTask({
      priority: 'med',
      estimateMinutes: 5,
      isStep: false,
      childStepCount: 0,
    });

    expect(none).toBe(five);
  });

  it('discounts a step, because it is part of one piece of work', () => {
    const parent = complexityForTask({
      priority: 'med',
      estimateMinutes: 30,
      isStep: false,
      childStepCount: 0,
    });
    const step = complexityForTask({
      priority: 'med',
      estimateMinutes: 30,
      isStep: true,
      childStepCount: 0,
    });

    expect(step).toBeLessThan(parent);
  });

  it('adds a bonus per child step, capped so a huge breakdown cannot run away', () => {
    const none = complexityForTask({
      priority: 'med',
      estimateMinutes: 30,
      isStep: false,
      childStepCount: 0,
    });
    const two = complexityForTask({
      priority: 'med',
      estimateMinutes: 30,
      isStep: false,
      childStepCount: 2,
    });
    const huge = complexityForTask({
      priority: 'med',
      estimateMinutes: 30,
      isStep: false,
      childStepCount: 100,
    });

    expect(two).toBeGreaterThan(none);
    expect(huge).toBe(none + 2);
  });
});

describe('speedFactorForCompletion', () => {
  it('is 1 when the task took exactly its estimate', () => {
    expect(
      speedFactorForCompletion(completion({ estimateMinutes: 15, completedAt: at('2026-10-29T09:15:00.000Z') })),
    ).toBe(1);
  });

  it('rewards finishing faster, up to the ceiling', () => {
    expect(
      speedFactorForCompletion(completion({ estimateMinutes: 30, completedAt: at('2026-10-29T09:15:00.000Z') })),
    ).toBe(SPEED_MAX);
  });

  it('penalises finishing slower, down to the floor', () => {
    expect(
      speedFactorForCompletion(completion({ estimateMinutes: 5, completedAt: at('2026-10-29T10:00:00.000Z') })),
    ).toBe(SPEED_MIN);
  });

  it('treats dwell as the estimate when there is no start signal', () => {
    // No startedAt: the fallback is createdAt, which measures dwell, not work.
    // Capping at the estimate makes a morning capture neutral (1.0) rather
    // than pinning every direct completion to the floor.
    const factor = speedFactorForCompletion(
      completion({
        estimateMinutes: 15,
        startedAt: null,
        createdAt: at('2026-10-29T05:00:00.000Z'),
        completedAt: at('2026-10-29T09:00:00.000Z'),
      }),
    );

    expect(factor).toBe(1);
  });

  it('floors actual time at one minute, so an instant completion cannot divide by zero', () => {
    const factor = speedFactorForCompletion(
      completion({
        estimateMinutes: 5,
        createdAt: at('2026-10-29T09:00:00.000Z'),
        startedAt: at('2026-10-29T09:00:00.000Z'),
        completedAt: at('2026-10-29T09:00:00.000Z'),
      }),
    );

    expect(Number.isFinite(factor)).toBe(true);
    expect(factor).toBe(SPEED_MAX);
  });

  it('falls back to a per-priority default when there is no estimate', () => {
    expect(PRIORITY_DEFAULT_MINUTES.urgent).toBeGreaterThan(0);
    expect(
      speedFactorForCompletion(
        completion({ priority: 'urgent', estimateMinutes: null, completedAt: at('2026-10-29T09:10:00.000Z') }),
      ),
    ).toBe(1);
  });
});

describe('performanceScore', () => {
  it('returns the parts it used, so the caller never recomputes them', () => {
    const result = performanceScore(completion());

    expect(typeof result.complexity).toBe('number');
    expect(typeof result.speedFactor).toBe('number');
    expect(typeof result.score).toBe('number');
  });

  it('never leaves the 0..SCORE_MAX band', () => {
    const slow = performanceScore(
      completion({ priority: 'low', estimateMinutes: 5, completedAt: at('2026-10-30T09:00:00.000Z') }),
    );
    const fast = performanceScore(
      completion({ priority: 'urgent', estimateMinutes: 240, completedAt: at('2026-10-29T09:01:00.000Z') }),
    );

    expect(slow.score).toBeGreaterThanOrEqual(0);
    expect(fast.score).toBeLessThanOrEqual(SCORE_MAX);
    expect(fast.score).toBeGreaterThan(slow.score);
  });

  it('pins the formula version so a later change cannot silently mix series', () => {
    expect(FORMULA_VERSION).toBe(1);
  });
});

describe('comparisonFor', () => {
  it('reports no-data until there are enough baseline samples', () => {
    expect(comparisonFor(120, 100, BASELINE_MIN_SAMPLES - 1)).toEqual({ status: 'no-data' });
  });

  it('reports no-data when either side is missing', () => {
    expect(comparisonFor(null, 100, 10)).toEqual({ status: 'no-data' });
    expect(comparisonFor(120, null, 10)).toEqual({ status: 'no-data' });
  });

  it('is above only outside the level band', () => {
    expect(comparisonFor(100 * (1 + LEVEL_BAND), 100, 10)).toMatchObject({
      status: 'ok',
      direction: 'above',
    });
  });

  it('is below only outside the level band', () => {
    expect(comparisonFor(100 * (1 - LEVEL_BAND), 100, 10)).toMatchObject({
      status: 'ok',
      direction: 'below',
    });
  });

  it('is level inside the band', () => {
    expect(comparisonFor(101, 100, 10)).toMatchObject({ status: 'ok', direction: 'level' });
  });
});

describe('eloTone', () => {
  it('maps every direction to a colour, so the client never invents one', () => {
    expect(ACTIVITY_DIRECTIONS.map(eloTone)).toEqual(['green', 'amber', 'red']);
  });
});
