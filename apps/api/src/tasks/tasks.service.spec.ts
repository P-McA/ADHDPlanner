import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GamificationService } from '../gamification/gamification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateTaskDto } from './dto/create-task.dto.js';
import { TasksService } from './tasks.service.js';

const USER_A = '11111111-1111-1111-1111-111111111111';
const TASK_ID = '22222222-2222-2222-2222-222222222222';

/** Minimal Prisma row; only the fields the mapper reads need to be real. */
function row(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: TASK_ID,
    userId: USER_A,
    title: 'task',
    description: null,
    status: 'pending',
    manualPriority: 'med',
    source: 'manual',
    dueAt: null,
    completedAt: null,
    confirmedAt: null,
    parentTaskId: null,
    ingestionRecordId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('TasksService', () => {
  let service: TasksService;
  let prisma: {
    task: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let gamification: { awardForCompletion: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      task: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        delete: vi.fn(),
      },
      // The service passes an array of prepared queries; resolving them in
      // order mirrors how Prisma batches a transaction.
      // Two shapes in use: remove() passes an array of operations, update()
      // passes a callback and needs a client handed back to it.
      $transaction: vi.fn((arg: unknown) => {
        if (typeof arg === 'function') {
          return (arg as (tx: typeof prisma) => unknown)(prisma);
        }
        return Promise.all(arg as unknown[]);
      }),
    };

    gamification = { awardForCompletion: vi.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [TasksService],
    })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        // TasksService only calls this on a completion transition; the awarding
        // itself is covered in gamification.service.spec.ts.
        if (token === GamificationService) return gamification;
        return undefined;
      })
      .compile();

    service = moduleRef.get(TasksService);
  });

  describe('ownership scoping', () => {
    it('scopes findOne to the calling user', async () => {
      prisma.task.findFirst.mockResolvedValue(row());

      await service.findOne(USER_A, TASK_ID);

      expect(prisma.task.findFirst).toHaveBeenCalledWith({
        where: { id: TASK_ID, userId: USER_A },
      });
    });

    it("reports another user's task as 404, not 403", async () => {
      // The row exists, but not for this user, so the scoped query misses.
      prisma.task.findFirst.mockResolvedValue(null);

      await expect(service.findOne(USER_A, TASK_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to update a task the caller does not own', async () => {
      prisma.task.findFirst.mockResolvedValue(null);

      await expect(service.update(USER_A, TASK_ID, { title: 'new' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it('refuses to delete a task the caller does not own', async () => {
      prisma.task.findFirst.mockResolvedValue(null);

      await expect(service.remove(USER_A, TASK_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.task.delete).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('rejects a parent the caller does not own', async () => {
      prisma.task.findFirst.mockResolvedValue(null);
      const dto: CreateTaskDto = { title: 'child', parentTaskId: TASK_ID };

      await expect(service.create(USER_A, dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it('checks parent ownership with the caller id, not just the parent id', async () => {
      prisma.task.findFirst.mockResolvedValue({ id: TASK_ID });
      prisma.task.create.mockResolvedValue(row({ parentTaskId: TASK_ID }));

      await service.create(USER_A, { title: 'child', parentTaskId: TASK_ID });

      expect(prisma.task.findFirst).toHaveBeenCalledWith({
        where: { id: TASK_ID, userId: USER_A },
        select: { id: true },
      });
    });

    it('skips the parent lookup entirely for a top-level task', async () => {
      prisma.task.create.mockResolvedValue(row());

      await service.create(USER_A, { title: 'solo' });

      expect(prisma.task.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('orders by due date ascending nulls last, then newest first', async () => {
      prisma.task.count.mockResolvedValue(0);
      prisma.task.findMany.mockResolvedValue([]);

      await service.list(USER_A, { limit: 25, offset: 0 });

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        }),
      );
    });

    it('applies the status filter and the user scope together', async () => {
      prisma.task.count.mockResolvedValue(0);
      prisma.task.findMany.mockResolvedValue([]);

      await service.list(USER_A, { status: 'done', limit: 25, offset: 0 });

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER_A, status: 'done' } }),
      );
    });

    it('reports total independently of the returned page', async () => {
      prisma.task.count.mockResolvedValue(42);
      prisma.task.findMany.mockResolvedValue([row()]);

      const page = await service.list(USER_A, { limit: 1, offset: 0 });

      expect(page.total).toBe(42);
      expect(page.items).toHaveLength(1);
    });
  });

  describe('remove', () => {
    it('returns the deleted id and its subtask count', async () => {
      prisma.task.findFirst.mockResolvedValue(row());
      prisma.task.count.mockResolvedValue(3);
      prisma.task.delete.mockResolvedValue(row());

      const result = await service.remove(USER_A, TASK_ID);

      expect(result).toEqual({ id: TASK_ID, deletedSubtasks: 3 });
      expect(prisma.task.count).toHaveBeenCalledWith({ where: { parentTaskId: TASK_ID } });
    });
  });

  describe('the draft fence', () => {
    const draft = row({ source: 'ai_suggested', confirmedAt: null });

    it('confirms a draft, which is the only way confirmedAt is ever written', async () => {
      const confirmed = new Date('2026-02-02T00:00:00.000Z');
      prisma.task.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(
        row({ source: 'ai_suggested', confirmedAt: confirmed }),
      );
      prisma.task.updateMany.mockResolvedValue({ count: 1 });

      const task = await service.approveDraft(USER_A, TASK_ID);

      expect(task.confirmedAt).toBe('2026-02-02T00:00:00.000Z');
      // The guard lives in the WHERE clause, so the database decides — a
      // read-then-write here would let two taps race to a second timestamp.
      expect(prisma.task.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TASK_ID, userId: USER_A, source: 'ai_suggested', confirmedAt: null },
        }),
      );
    });

    it('is idempotent: approving twice leaves the first confirmation standing', async () => {
      const confirmedAt = new Date('2026-02-02T00:00:00.000Z');
      prisma.task.findFirst.mockResolvedValue(row({ source: 'ai_suggested', confirmedAt }));
      // The conditional WHERE matched nothing the second time round.
      prisma.task.updateMany.mockResolvedValue({ count: 0 });

      const task = await service.approveDraft(USER_A, TASK_ID);

      expect(task.confirmedAt).toBe(confirmedAt.toISOString());
    });

    it('archives a rejected draft but leaves it unconfirmed', async () => {
      prisma.task.findFirst
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce(row({ source: 'ai_suggested', status: 'archived' }));
      prisma.task.updateMany.mockResolvedValue({ count: 1 });

      const task = await service.rejectDraft(USER_A, TASK_ID);

      expect(task.status).toBe('archived');
      // Rejecting is not confirming: the row stays evidence of a suggestion
      // the user turned down, which is how an over-extracting prompt is found.
      expect(task.confirmedAt).toBeNull();
      expect(prisma.task.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'archived' } }),
      );
    });

    it('404s on someone else’s draft before touching anything', async () => {
      prisma.task.findFirst.mockResolvedValue(null);

      await expect(service.approveDraft(USER_A, TASK_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.task.updateMany).not.toHaveBeenCalled();
    });

    it('cannot confirm a hand-typed task by approving it', async () => {
      prisma.task.findFirst.mockResolvedValue(row({ source: 'manual' }));
      prisma.task.updateMany.mockResolvedValue({ count: 0 });

      const task = await service.approveDraft(USER_A, TASK_ID);

      // The source guard is in the WHERE clause too, so a manual task comes
      // back untouched rather than acquiring a confirmation it never needed.
      expect(task.confirmedAt).toBeNull();
    });
  });

  it('serialises dates as ISO strings', async () => {
    prisma.task.findFirst.mockResolvedValue(row({ dueAt: new Date('2026-05-05T10:00:00.000Z') }));

    const task = await service.findOne(USER_A, TASK_ID);

    expect(task.dueAt).toBe('2026-05-05T10:00:00.000Z');
    expect(task.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
