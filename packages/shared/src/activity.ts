import type { EstimateMinutes } from './estimation.js';
import type { TaskPriority } from './task.js';

/**
 * How a user wants progress shown.
 *
 * `metrics` is the adult default: counts and a performance rating, no XP
 * theatre. `xp` is the rewards view a parent uses with a child. The mode is a
 * display choice only — the XP ledger keeps accruing either way, so switching
 * back never loses history.
 */
export const TRACKING_MODES = ['metrics', 'xp'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

export function isTrackingMode(value: unknown): value is TrackingMode {
  return typeof value === 'string' && (TRACKING_MODES as readonly string[]).includes(value);
}

/**
 * Which side of their own baseline a period sits on.
 *
 * Deliberately not including "no data": that is a different state, and making
 * it a direction would force every client to special-case a member that has no
 * colour. `ActivityComparison` carries it instead.
 */
export const ACTIVITY_DIRECTIONS = ['above', 'level', 'below'] as const;
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number];

export type ActivityTone = 'green' | 'amber' | 'red';

/** The one user-facing label per direction, so both clients agree. */
export const ACTIVITY_DIRECTION_LABELS: Record<ActivityDirection, string> = {
  above: 'Above your average',
  level: 'On your average',
  below: 'Below your average',
};

/** The one mapping from direction to colour, so both clients agree. */
export function eloTone(direction: ActivityDirection): ActivityTone {
  switch (direction) {
    case 'above':
      return 'green';
    case 'level':
      return 'amber';
    case 'below':
      return 'red';
  }
}

/**
 * One period's comparison against the trailing baseline.
 *
 * A discriminated union rather than two independent nullable fields: a client
 * must never be able to render "above" beside a missing number.
 */
export type ActivityComparison =
  | { status: 'no-data' }
  | { status: 'ok'; direction: ActivityDirection; current: number; baseline: number };

/** One day of the sparkline; `rating` is null on a day with no completions. */
export interface ActivitySeriesPoint {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  rating: number | null;
}

/** The metric view behind GET /me/activity. */
export interface ActivityMetrics {
  counts: {
    completedToday: number;
    completedThisWeek: number;
    completedThisMonth: number;
  };
  /** Open work right now (pending + in progress), drafts excluded. */
  pending: number;
  day: ActivityComparison;
  week: ActivityComparison;
  month: ActivityComparison;
  /** The last 30 local days, oldest first, for the sparkline. */
  series: ActivitySeriesPoint[];
}

/**
 * How much a completion is worth before speed is considered.
 *
 * Keyed by the existing priority enum so adding a priority is a compile error
 * here rather than a silent zero.
 */
export const PRIORITY_COMPLEXITY: Record<TaskPriority, number> = {
  low: 1,
  med: 2,
  high: 3,
  urgent: 4,
};

/**
 * The estimate's multiplier on complexity. Longer work is harder work.
 *
 * An absent estimate uses the same factor as the shortest bucket: the app must
 * not invent complexity it was never told about.
 */
export const ESTIMATE_COMPLEXITY_FACTOR: Record<EstimateMinutes, number> = {
  5: 1.0,
  15: 1.2,
  30: 1.5,
  60: 2.0,
  120: 2.5,
  240: 3.0,
};

export const NO_ESTIMATE_COMPLEXITY_FACTOR = 1.0;

/** A step is part of one piece of work, so it is worth less than its parent. */
export const STEP_COMPLEXITY_FACTOR = 0.5;

/** Each child step makes the parent more complex, up to a cap. */
export const STEP_COMPLEXITY_BONUS = 0.5;
export const STEP_COMPLEXITY_BONUS_CAP = 2;

/**
 * Minutes to assume when the user gave no estimate, by priority.
 *
 * Must stay above zero: it is the denominator of the speed ratio.
 */
export const PRIORITY_DEFAULT_MINUTES: Record<TaskPriority, number> = {
  low: 30,
  med: 20,
  high: 15,
  urgent: 10,
};

/** Actual time is floored here, so an instant completion cannot divide by zero. */
export const MIN_ACTUAL_SECONDS = 60;

/**
 * When there is no start signal, the fallback is `createdAt` — which measures
 * dwell, not work. Capping at twice the expected time keeps a morning capture
 * from always scoring the floor.
 */
export const DWELL_CAP_MULTIPLIER = 1;

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2.0;

export const SCORE_SCALE = 100;
export const SCORE_MAX = 1000;

/** Bumped when the formula changes, so a series cannot silently mix versions. */
export const FORMULA_VERSION = 1;

/** Baseline windows, in their own units, excluding the current period. */
export const BASELINE_DAYS = 7;
export const BASELINE_WEEKS = 4;
export const BASELINE_MONTHS = 3;

/** Below this many baseline samples, a comparison is not shown. */
export const BASELINE_MIN_SAMPLES = 3;

/** Within this fraction of the baseline is "level"; outside it is above/below. */
export const LEVEL_BAND = 0.05;

export interface ComplexityInput {
  priority: TaskPriority;
  estimateMinutes: EstimateMinutes | null;
  isStep: boolean;
  /** Children of this task, for the parent's bonus. Zero for a step. */
  childStepCount: number;
}

/** The complexity half of the score. Pure; no clock, no I/O. */
export function complexityForTask(input: ComplexityInput): number {
  const estimateFactor =
    input.estimateMinutes === null
      ? NO_ESTIMATE_COMPLEXITY_FACTOR
      : ESTIMATE_COMPLEXITY_FACTOR[input.estimateMinutes];

  const base = PRIORITY_COMPLEXITY[input.priority] * estimateFactor;

  if (input.isStep) {
    return base * STEP_COMPLEXITY_FACTOR;
  }

  const bonus = Math.min(input.childStepCount * STEP_COMPLEXITY_BONUS, STEP_COMPLEXITY_BONUS_CAP);

  return base + bonus;
}

export interface SpeedInput {
  priority: TaskPriority;
  estimateMinutes: EstimateMinutes | null;
  createdAt: Date;
  /** Null when the user never started it; the fallback is `createdAt`. */
  startedAt: Date | null;
  completedAt: Date;
}

/**
 * The speed half of the score: expected time over actual time, clamped.
 *
 * Faster than expected is worth more, slower is worth less, and the clamp
 * stops a two-second tap or a forgotten task from dominating the rating.
 */
export function speedFactorForCompletion(input: SpeedInput): number {
  const expectedSeconds = (input.estimateMinutes ?? PRIORITY_DEFAULT_MINUTES[input.priority]) * 60;
  const from = input.startedAt ?? input.createdAt;
  const rawSeconds = (input.completedAt.getTime() - from.getTime()) / 1000;

  // Dwell is only a proxy for work when there was no start signal. Cap it so
  // the proxy cannot pin every direct completion to the floor.
  const cappedSeconds =
    input.startedAt === null ? Math.min(rawSeconds, expectedSeconds * DWELL_CAP_MULTIPLIER) : rawSeconds;

  const actualSeconds = Math.max(cappedSeconds, MIN_ACTUAL_SECONDS);

  return clamp(expectedSeconds / actualSeconds, SPEED_MIN, SPEED_MAX);
}

export interface PerformanceInput extends ComplexityInput, SpeedInput {}

export interface PerformanceResult {
  complexity: number;
  speedFactor: number;
  score: number;
}

/** The whole score, returning its parts so the caller never recomputes them. */
export function performanceScore(input: PerformanceInput): PerformanceResult {
  const complexity = complexityForTask(input);
  const speedFactor = speedFactorForCompletion(input);
  const score = clamp(Math.round(complexity * speedFactor * SCORE_SCALE), 0, SCORE_MAX);

  return { complexity, speedFactor, score };
}

/**
 * Compares a period's rating with its baseline.
 *
 * `samples` is the number of baseline days, not events: one very busy day is
 * still one day of evidence. Below the minimum the answer is `no-data` rather
 * than a confident comparison against nothing.
 */
export function comparisonFor(
  current: number | null,
  baseline: number | null,
  samples: number,
): ActivityComparison {
  if (current === null || baseline === null || samples < BASELINE_MIN_SAMPLES) {
    return { status: 'no-data' };
  }

  // A zero baseline has no band to sit inside; any activity is above it.
  if (baseline === 0) {
    return { status: 'ok', direction: current > 0 ? 'above' : 'level', current, baseline };
  }

  if (current >= baseline * (1 + LEVEL_BAND)) {
    return { status: 'ok', direction: 'above', current, baseline };
  }

  if (current <= baseline * (1 - LEVEL_BAND)) {
    return { status: 'ok', direction: 'below', current, baseline };
  }

  return { status: 'ok', direction: 'level', current, baseline };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
