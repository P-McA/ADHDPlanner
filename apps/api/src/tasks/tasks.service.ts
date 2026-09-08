import {
  TASK_LIST_DEFAULT_LIMIT,
  type DeleteTaskResult,
  type Task,
  type TaskPage,
} from '@adhd/shared';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Task as PrismaTask } from '@prisma/client';

import { GamificationService } from '../gamification/gamification.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateTaskDto } from './dto/create-task.dto.js';
import type { ListTasksQueryDto } from './dto/list-tasks-query.dto.js';
import type { UpdateTaskDto } from './dto/update-task.dto.js';

/** Prisma row to wire contract. Dates become ISO strings to survive JSON. */
function toTask(row: PrismaTask): Task {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    description: row.description,
    status: row.status,
    manualPriority: row.manualPriority,
    source: row.source,
    dueAt: row.dueAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    parentTaskId: row.parentTaskId,
    ingestionRecordId: row.ingestionRecordId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Task CRUD, scoped to the calling user.
 *
 * Ownership rule: every read and write filters on `userId`, and a row that
 * exists but belongs to someone else is reported as 404, never 403. A 403
 * would confirm the id is real, letting a caller enumerate other users' task
 * ids; 404 keeps existence and ownership indistinguishable from outside.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gamification: GamificationService,
  ) {}

  async create(userId: string, dto: CreateTaskDto): Promise<Task> {
    if (dto.parentTaskId) {
      await this.assertOwnedParent(userId, dto.parentTaskId);
    }

    const created = await this.prisma.task.create({
      data: {
        userId,
        title: dto.title,
        description: dto.description ?? null,
        manualPriority: dto.manualPriority,
        source: dto.source,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        parentTaskId: dto.parentTaskId ?? null,
      },
    });

    return toTask(created);
  }

  async findOne(userId: string, id: string): Promise<Task> {
    const row = await this.prisma.task.findFirst({ where: { id, userId } });

    if (!row) {
      throw new NotFoundException(`Task ${id} not found`);
    }

    return toTask(row);
  }

  /**
   * A page of the user's tasks.
   *
   * Ordered by due date ascending with nulls last — undated tasks sort after
   * dated ones rather than monopolising the top of the list — then newest
   * first within the same due date.
   */
  async list(userId: string, query: ListTasksQueryDto): Promise<TaskPage> {
    const limit = query.limit ?? TASK_LIST_DEFAULT_LIMIT;
    const offset = query.offset ?? 0;
    const where = { userId, ...(query.status ? { status: query.status } : {}) };

    // Count and page in one round trip; the count reflects the whole filter,
    // not the slice, so clients can size pagination controls.
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
    ]);

    return { items: rows.map(toTask), total, limit, offset };
  }

  async update(userId: string, id: string, dto: UpdateTaskDto): Promise<Task> {
    // Scoped existence check first: updateMany would report 0 rows for both
    // "missing" and "someone else's", but this keeps the 404 message honest
    // without a second meaning.
    const existing = await this.findOne(userId, id);

    // Everything except the status transition. Kept separate because the
    // transition is applied conditionally below, and a PATCH carrying both an
    // edit and status:'done' must not lose the edit when the transition is a
    // no-op.
    const edits = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.manualPriority !== undefined ? { manualPriority: dto.manualPriority } : {}),
      ...(dto.dueAt !== undefined ? { dueAt: new Date(dto.dueAt) } : {}),
    };

    // One instant for the whole operation, so the stored completedAt and the
    // day the streak is credited to cannot straddle midnight.
    const now = new Date();

    if (dto.status !== 'done') {
      const isReopening = dto.status !== undefined && existing.status === 'done';

      const row = await this.prisma.task.update({
        where: { id },
        data: {
          ...edits,
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          // Reopening clears it, so completedAt always describes the current
          // state rather than the last time it happened to be done.
          ...(isReopening ? { completedAt: null } : {}),
        },
      });

      return toTask(row);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // The idempotency guard, expressed as a condition the database evaluates
      // while holding the row lock rather than as a decision made from an
      // earlier read. Two simultaneous completions both reach this statement;
      // Postgres serialises them on the row, and at READ COMMITTED the loser
      // re-evaluates `status: { not: 'done' }` against the winner's committed
      // row and matches nothing. So exactly one of them pays.
      //
      // `userId` stays in the where clause: this is the statement that actually
      // writes, so it carries the ownership scope rather than trusting the
      // check above to still hold.
      const claim = await tx.task.updateMany({
        where: { id, userId, status: { not: 'done' } },
        data: { ...edits, status: 'done', completedAt: now },
      });

      // count === 1 means this call is the one that completed the task, and it
      // is the only one that pays. count === 0 means the task was already done
      // — either before this request or because a concurrent one won — so the
      // completion is a no-op and no XP is awarded.
      const won = claim.count === 1;

      if (!won) {
        // The transition did not apply, but the other fields still must: the
        // caller asked for them and their task not being re-completable is
        // unrelated to whether it can be renamed.
        const row =
          Object.keys(edits).length > 0
            ? await tx.task.update({ where: { id }, data: edits })
            : await tx.task.findUniqueOrThrow({ where: { id } });

        return row;
      }

      // updateMany cannot return the row, so read back what was just written.
      const row = await tx.task.findUniqueOrThrow({ where: { id } });

      // Same transaction as the task update on purpose: a task must never be
      // able to show as done with no XP behind it, or the reverse.
      await this.gamification.awardForCompletion(tx, {
        userId,
        taskId: id,
        priority: row.manualPriority,
        now,
      });

      return row;
    });

    return toTask(updated);
  }

  /**
   * The user accepts an AI suggestion: it stops being a draft.
   *
   * This is the only place `confirmedAt` is ever written, and there is no route
   * that clears it — the fence only opens in one direction, by a deliberate act
   * of the person whose list it is.
   *
   * Conditional and therefore idempotent, in the same style as completion: the
   * `confirmedAt: null` guard is evaluated by the database, so two taps on the
   * approve button leave one confirmation timestamp rather than the second
   * quietly moving it later. Approving a task that was never a draft is a
   * no-op that returns the task, not an error: the caller asked for it to be
   * confirmed and it is.
   */
  async approveDraft(userId: string, id: string): Promise<Task> {
    await this.findOne(userId, id);

    await this.prisma.task.updateMany({
      where: { id, userId, source: 'ai_suggested', confirmedAt: null },
      data: { confirmedAt: new Date() },
    });

    return this.findOne(userId, id);
  }

  /**
   * The user rejects an AI suggestion.
   *
   * Archived rather than deleted, and `confirmedAt` deliberately left null: the
   * row stays a draft that was turned down, which keeps the evidence of what
   * the extractor proposed and the user did not want. That trail is the only
   * way to tell a prompt that over-extracts from one that works, and it costs
   * a row nobody lists — `archived` is already excluded from the open views.
   */
  async rejectDraft(userId: string, id: string): Promise<Task> {
    await this.findOne(userId, id);

    await this.prisma.task.updateMany({
      where: { id, userId, source: 'ai_suggested', confirmedAt: null },
      data: { status: 'archived' },
    });

    return this.findOne(userId, id);
  }

  /**
   * Deletes a task and, by database cascade, its subtasks.
   *
   * The subtask count is taken inside the same transaction as the delete so
   * the reported number cannot drift from what was actually removed.
   */
  async remove(userId: string, id: string): Promise<DeleteTaskResult> {
    await this.findOne(userId, id);

    const [deletedSubtasks] = await this.prisma.$transaction([
      this.prisma.task.count({ where: { parentTaskId: id } }),
      this.prisma.task.delete({ where: { id } }),
    ]);

    return { id, deletedSubtasks };
  }

  /**
   * A parent must exist *and* belong to the caller.
   *
   * Without the ownership half, a caller could attach their task to a stranger's
   * and infer that stranger's task ids from which values are accepted.
   */
  private async assertOwnedParent(userId: string, parentTaskId: string): Promise<void> {
    const parent = await this.prisma.task.findFirst({
      where: { id: parentTaskId, userId },
      select: { id: true },
    });

    if (!parent) {
      throw new BadRequestException(`Parent task ${parentTaskId} not found`);
    }
  }
}
