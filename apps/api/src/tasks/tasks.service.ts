import {
  isTaskDraft,
  TASK_LIST_DEFAULT_LIMIT,
  toEstimateMinutes,
  type DeleteTaskResult,
  type EstimateMinutes,
  type StepCandidate,
  type Task,
  type TaskPage,
} from '@adhd/shared';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, Task as PrismaTask } from '@prisma/client';

import { DECOMPOSER, type Decomposer, ESTIMATOR, type Estimator } from '../ai/ai.ports.js';
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
    stepOrder: row.stepOrder,
    // Through toEstimateMinutes rather than a cast: the CHECK constraint makes a
    // non-bucket impossible to store, and this keeps the type honest about it.
    estimateMinutes: toEstimateMinutes(row.estimateMinutes),
    suggestedEstimateMinutes: toEstimateMinutes(row.suggestedEstimateMinutes),
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
    @Inject(DECOMPOSER) private readonly decomposer: Decomposer,
    @Inject(ESTIMATOR) private readonly estimator: Estimator,
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
        estimateMinutes: dto.estimateMinutes ?? null,
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
    // The fence, applied by the database rather than by whoever renders the
    // result. `NOT` over both columns is `isTaskDraft` inverted: an approved
    // suggestion has a confirmedAt and stays, a hand-typed task has no
    // ai_suggested source and stays. Only the unconfirmed suggestion drops out.
    //
    // Excluding by default rather than requiring `?exclude=drafts` is the whole
    // point: the failure mode of forgetting the parameter has to be a page with
    // too little on it, never a suggestion nobody approved sitting in the day's
    // work looking like a decision the user already made.
    const where = {
      userId,
      // Top level only. A step lives under its parent (`GET /tasks/:id/steps`);
      // listed here too, an approved step would show twice and a suggested
      // one would leak into the suggestions list that `include=drafts` feeds.
      parentTaskId: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.include === 'drafts'
        ? {}
        : { NOT: { source: 'ai_suggested' as const, confirmedAt: null } }),
    };

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

    // The other half of the fence. Completing a task is the act that pays XP
    // and moves the streak, so allowing it on an unconfirmed suggestion would
    // credit the user for work no human ever agreed to do — the exact failure
    // "never auto-create" exists to prevent, arriving one PATCH later.
    //
    // 409, not 404: the task exists and the caller owns it, and pretending
    // otherwise would send a client hunting for a missing row instead of
    // telling it the one thing it needs to know. (404-for-someone-else's-task
    // stays as it was — that hides existence, which is a different job.)
    //
    // Only `done` is blocked. Editing a draft's title or due date before
    // approving it is ordinary review work, and moving it to `in_progress`
    // pays nothing, so neither needs the fence.
    if (dto.status === 'done' && isTaskDraft(existing)) {
      throw new ConflictException(
        'This task is an unconfirmed AI suggestion. Approve it before completing it.',
      );
    }

    // Everything except the status transition. Kept separate because the
    // transition is applied conditionally below, and a PATCH carrying both an
    // edit and status:'done' must not lose the edit when the transition is a
    // no-op.
    const edits = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.manualPriority !== undefined ? { manualPriority: dto.manualPriority } : {}),
      ...(dto.dueAt !== undefined ? { dueAt: new Date(dto.dueAt) } : {}),
      ...(dto.estimateMinutes !== undefined ? { estimateMinutes: dto.estimateMinutes } : {}),
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
        isStep: row.parentTaskId !== null,
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
   *
   * `status: { not: 'archived' }` makes rejection final in the same breath. It
   * also closes the only way the review XP below could be paid twice for one
   * suggestion: reject (pays), then approve (would match again, and pay again).
   */
  async approveDraft(userId: string, id: string): Promise<Task> {
    await this.findOne(userId, id);

    await this.reviewDraft(userId, id, { confirmedAt: new Date() });

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

    await this.reviewDraft(userId, id, { status: 'archived' });

    return this.findOne(userId, id);
  }

  /**
   * The shared body of approve and reject: flip the draft, and pay for the
   * feedback if and only if this call is the one that flipped it.
   *
   * The WHERE clause is the whole design. It matches an unconfirmed,
   * un-rejected AI suggestion owned by the caller, which is a state each draft
   * leaves exactly once and never returns to — so `count === 1` happens once
   * per suggestion for the life of the row, whichever direction it goes, and
   * the second tap on either button pays nothing. That is a condition the
   * database evaluates under the row lock rather than a decision made from an
   * earlier read, so two concurrent taps cannot both see "not yet reviewed".
   *
   * Both writes share one transaction because the XP is payment for the
   * review: a ledger row for a draft still sitting unreviewed would be XP for
   * nothing, and a reviewed draft with no ledger row silently loses the
   * feedback signal the payment exists to buy.
   */
  private async reviewDraft(
    userId: string,
    id: string,
    data: { confirmedAt: Date } | { status: 'archived' },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.task.updateMany({
        where: {
          id,
          userId,
          source: 'ai_suggested',
          confirmedAt: null,
          status: { not: 'archived' },
        },
        data,
      });

      if (claim.count === 1) {
        await this.gamification.awardForDraftReview(tx, { userId, taskId: id });
      }
    });
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
   * "Break this into steps": asks the model, then writes what it proposed as
   * draft steps under the task — `ai_suggested`, unconfirmed, ordered. Nothing
   * here can produce a confirmed row; the user adds each step themselves.
   *
   * Refused (409) before the model is asked, so a refusal costs nothing:
   * - the task is itself a step — steps are one level deep;
   * - it is done or archived — there is nothing left to start;
   * - it is an unconfirmed suggestion — approve it first;
   * - it already has step suggestions waiting for review — a second press
   *   would pay the model again for a second set of the same thing.
   *
   * The last check runs twice: once up front to save the call, and again inside
   * the transaction that writes, under a lock on the parent row, because two
   * presses can both pass the first check while the model is thinking. Only one
   * of them gets to write; the other is a 409 and its result is discarded.
   */
  async breakIntoSteps(userId: string, id: string): Promise<Task[]> {
    const parent = await this.prisma.task.findFirst({ where: { id, userId } });

    if (!parent) {
      throw new NotFoundException(`Task ${id} not found`);
    }

    if (parent.parentTaskId !== null) {
      throw new ConflictException('This is already a step; steps are not broken down further');
    }

    if (parent.status === 'done' || parent.status === 'archived') {
      throw new ConflictException(`This task is ${parent.status}; there is nothing left to break down`);
    }

    if (isTaskDraft({ source: parent.source, confirmedAt: parent.confirmedAt?.toISOString() ?? null })) {
      throw new ConflictException('Add this suggestion to your tasks before breaking it into steps');
    }

    await this.assertNoPendingSteps(this.prisma, id);

    let candidates: StepCandidate[];

    try {
      candidates = await this.decomposer.decompose({
        title: parent.title,
        description: parent.description,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new BadGatewayException(`Could not break that task down: ${message}`);
    }

    const rows = await this.prisma.$transaction(async (tx) => {
      // Takes the row lock on the parent; a concurrent press waits here, then
      // sees the steps this one wrote.
      await tx.task.updateMany({ where: { id, userId }, data: { updatedAt: new Date() } });
      await this.assertNoPendingSteps(tx, id);

      const created: PrismaTask[] = [];

      for (const [stepOrder, candidate] of candidates.entries()) {
        created.push(
          await tx.task.create({
            data: {
              userId,
              title: candidate.title,
              parentTaskId: id,
              stepOrder,
              source: 'ai_suggested',
              confirmedAt: null,
            },
          }),
        );
      }

      return created;
    });

    return rows.map(toTask);
  }

  /** A task's steps in order: suggestions and accepted ones, not rejected. */
  async listSteps(userId: string, id: string): Promise<Task[]> {
    await this.findOne(userId, id);

    const rows = await this.prisma.task.findMany({
      where: { userId, parentTaskId: id, status: { not: 'archived' } },
      orderBy: [{ stepOrder: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });

    return rows.map(toTask);
  }

  /**
   * "How long will this take?": asks the model and stores its answer as a
   * *suggestion* on the task. Nothing here touches `estimateMinutes`, which is
   * the user's; the suggestion only becomes theirs through acceptEstimate.
   *
   * Refused (409) before the model is asked, so a refusal costs nothing: the
   * task is done or archived (nothing left to plan), an unconfirmed suggestion
   * (approve it first), or already has a suggested estimate waiting (a second
   * press would pay the model again for the same answer).
   *
   * The write is conditional on there still being no suggestion, so two
   * presses that both passed the first check while the model was thinking give
   * one 200 and one 409, never a second answer silently replacing the first.
   */
  async suggestEstimate(userId: string, id: string): Promise<Task> {
    const task = await this.prisma.task.findFirst({ where: { id, userId } });

    if (!task) {
      throw new NotFoundException(`Task ${id} not found`);
    }

    if (task.status === 'done' || task.status === 'archived') {
      throw new ConflictException(`This task is ${task.status}; there is nothing left to estimate`);
    }

    if (isTaskDraft({ source: task.source, confirmedAt: task.confirmedAt?.toISOString() ?? null })) {
      throw new ConflictException('Add this suggestion to your tasks before estimating it');
    }

    if (task.suggestedEstimateMinutes !== null) {
      throw new ConflictException('This task already has a suggested estimate waiting; accept or dismiss it first');
    }

    let minutes: EstimateMinutes;

    try {
      minutes = await this.estimator.estimate({ title: task.title, description: task.description });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new BadGatewayException(`Could not estimate that task: ${message}`);
    }

    const claim = await this.prisma.task.updateMany({
      where: { id, userId, suggestedEstimateMinutes: null },
      data: { suggestedEstimateMinutes: minutes },
    });

    if (claim.count === 0) {
      throw new ConflictException('This task already has a suggested estimate waiting; accept or dismiss it first');
    }

    return this.findOne(userId, id);
  }

  /** Takes the suggestion — or `minutes`, a correction of it — as the user's estimate. */
  acceptEstimate(userId: string, id: string, minutes?: EstimateMinutes): Promise<Task> {
    return this.reviewEstimate(userId, id, (suggested) => ({
      estimateMinutes: minutes ?? suggested,
      suggestedEstimateMinutes: null,
    }));
  }

  /** Drops the suggestion; the user's own estimate, if any, is left alone. */
  dismissEstimate(userId: string, id: string): Promise<Task> {
    return this.reviewEstimate(userId, id, () => ({ suggestedEstimateMinutes: null }));
  }

  /**
   * Accept and dismiss share this, as approve and reject share reviewDraft.
   *
   * The claim is one conditional `updateMany` on the suggestion the caller saw,
   * so two presses landing together give one 200 and one 409: the second waits
   * on the row lock, then finds the suggestion gone. The review XP is paid in
   * the same transaction and keyed per task, so it is paid once however many
   * times the task is estimated and reviewed.
   */
  private async reviewEstimate(
    userId: string,
    id: string,
    data: (suggested: number) => Prisma.TaskUpdateManyMutationInput,
  ): Promise<Task> {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.task.findFirst({ where: { id, userId } });

      if (!current) {
        throw new NotFoundException(`Task ${id} not found`);
      }

      if (current.suggestedEstimateMinutes === null) {
        throw new ConflictException('This task has no suggested estimate to review');
      }

      const claim = await tx.task.updateMany({
        where: { id, userId, suggestedEstimateMinutes: current.suggestedEstimateMinutes },
        data: data(current.suggestedEstimateMinutes),
      });

      if (claim.count !== 1) {
        throw new ConflictException('This task has no suggested estimate to review');
      }

      await this.gamification.awardForEstimateReview(tx, { userId, taskId: id });

      return tx.task.findUniqueOrThrow({ where: { id } });
    });

    return toTask(row);
  }

  private async assertNoPendingSteps(
    client: Pick<PrismaService, 'task'> | Prisma.TransactionClient,
    parentTaskId: string,
  ): Promise<void> {
    const pending = await client.task.count({
      where: { parentTaskId, source: 'ai_suggested', confirmedAt: null, status: { not: 'archived' } },
    });

    if (pending > 0) {
      throw new ConflictException(
        'This task already has suggested steps waiting; add or reject those first',
      );
    }
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
