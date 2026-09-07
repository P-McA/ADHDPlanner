import {
  TASK_LIST_DEFAULT_LIMIT,
  type DeleteTaskResult,
  type Task,
  type TaskPage,
} from '@adhd/shared';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Task as PrismaTask } from '@prisma/client';

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
    parentTaskId: row.parentTaskId,
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
  constructor(private readonly prisma: PrismaService) {}

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
    await this.findOne(userId, id);

    const updated = await this.prisma.task.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.manualPriority !== undefined ? { manualPriority: dto.manualPriority } : {}),
        ...(dto.dueAt !== undefined ? { dueAt: new Date(dto.dueAt) } : {}),
      },
    });

    return toTask(updated);
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
