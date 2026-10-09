import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Decomposer, Estimator } from '../ai/ai.ports.js';
import type { GamificationService } from '../gamification/gamification.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { decodeNextCursor, encodeNextCursor } from './next-cursor.js';
import { TasksService } from './tasks.service.js';

/**
 * The parts of "Next up" the e2e suite cannot reach, because they need a
 * fixed clock: the day is the *user's*, and a cursor keeps the day the list
 * was first ranked on. The database half — which rows are in the set, and
 * paging over real rows — is `test/next-up.e2e-spec.ts`.
 */

const USER = '11111111-1111-1111-1111-111111111111';

function row(id: string, dueAt: string | null) {
  const at = new Date('2026-01-01T00:00:00.000Z');

  return {
    id,
    userId: USER,
    title: id,
    description: null,
    status: 'pending',
    manualPriority: 'med',
    source: 'manual',
    dueAt: dueAt === null ? null : new Date(dueAt),
    completedAt: null,
    confirmedAt: null,
    parentTaskId: null,
    stepOrder: null,
    estimateMinutes: null,
    suggestedEstimateMinutes: null,
    suggestionReason: null,
    ingestionRecordId: null,
    createdAt: at,
    updatedAt: at,
  };
}

function service(timezone: string, rows: ReturnType<typeof row>[]) {
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ timezone }) },
    task: { findMany: vi.fn().mockResolvedValue(rows) },
  } as unknown as PrismaService;

  return new TasksService(
    prisma,
    {} as GamificationService,
    {} as Decomposer,
    {} as Estimator,
  );
}

describe('TasksService.listNext — the user’s day', () => {
  // 2026-10-09T20:00Z is 09:00 on the 10th in Auckland, still the 9th in UTC.
  const NOW = new Date('2026-10-09T20:00:00.000Z');
  // Due 2026-10-10T10:00Z: the 10th in both zones.
  const DUE = '2026-10-10T10:00:00.000Z';

  it('calls it "due today" in Auckland, where it is already the 10th', async () => {
    const page = await service('Pacific/Auckland', [row('a', DUE)]).listNext(USER, {}, NOW);

    expect(page.items[0]!.rank.reasons).toContain('Due today');
  });

  it('calls the same task "due tomorrow" in UTC, where it is still the 9th', async () => {
    const page = await service('UTC', [row('a', DUE)]).listNext(USER, {}, NOW);

    expect(page.items[0]!.rank.reasons).toContain('Due tomorrow');
  });
});

describe('TasksService.listNext — paging keeps the day it started on', () => {
  it('ranks a later page against the cursor’s instant, not the clock', async () => {
    // On the 9th, "p" (due the 15th, high) scores 60 and "q" (due the 11th)
    // scores 50, so page one is [p]. Overnight q becomes "due tomorrow" and
    // would score 70 — ahead of the cursor at 60. Re-scored on the 10th, page
    // two would start *after* q and q would never be shown.
    const p = { ...row('p', '2026-10-15T12:00:00.000Z'), manualPriority: 'high' };
    const rows = [p, row('q', '2026-10-11T12:00:00.000Z'), row('r', null)];
    const svc = service('UTC', rows);
    const first = await svc.listNext(USER, { limit: 1 }, new Date('2026-10-09T23:59:00.000Z'));

    const second = await svc.listNext(
      USER,
      { limit: 5, cursor: first.nextCursor! },
      new Date('2026-10-10T08:00:00.000Z'),
    );

    expect(first.items.map((item) => item.id)).toEqual(['p']);
    expect(second.items.map((item) => item.id)).toEqual(['q', 'r']);
  });
});

describe('next cursor', () => {
  it('round-trips what it encodes', () => {
    const cursor = { asOf: '2026-10-09T12:00:00.000Z', score: 70, id: 'abc' };

    expect(decodeNextCursor(encodeNextCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ['not base64 JSON', 'not-a-cursor'],
    ['the wrong shape', Buffer.from(JSON.stringify({ page: 2 })).toString('base64url')],
    [
      'a date that is not a date',
      Buffer.from(JSON.stringify({ asOf: 'soon', score: 1, id: 'a' })).toString('base64url'),
    ],
  ])('refuses %s with a 400, never a silent first page', (_label, raw) => {
    expect(() => decodeNextCursor(raw)).toThrow(BadRequestException);
  });
});
