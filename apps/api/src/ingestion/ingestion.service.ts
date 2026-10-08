import type { DeleteIngestionResult, IngestionRecord } from '@adhd/shared';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { IngestionRecord as PrismaIngestionRecord } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { AudioIngestionQueue } from './audio-ingestion.queue.js';
import { audioObjectKey, type UploadedAudio } from './audio-upload.validation.js';

/** Prisma row to the shared wire shape: Dates become ISO strings. */
function toContract(row: PrismaIngestionRecord): IngestionRecord {
  return {
    id: row.id,
    userId: row.userId,
    objectKey: row.objectKey,
    status: row.status,
    transcript: row.transcript,
    error: row.error,
    failureKind: row.failureKind,
    autoRetries: row.autoRetries,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: AudioIngestionQueue,
  ) {}

  /**
   * Stores the audio, records it, and queues it for transcription.
   *
   * Order matters. The object is written first, so a record never points at a
   * key that does not exist; the row is written second, which is what makes
   * the upload visible to the user; the job is enqueued last, because it is
   * the only step that can be recovered from without the caller — a record
   * whose job never landed can be re-queued later, whereas a job pointing at a
   * row that was never committed is unrecoverable.
   *
   * A failure to enqueue therefore does not fail the request: the bytes and
   * the record are safely stored, and 202 is still the truth. What it must not
   * do is leave the row on `uploaded`, which is indistinguishable from a job
   * waiting its turn — the record is moved to `failed` with the reason, so the
   * state is inspectable rather than stranded, and the user can retry it
   * (`retry`, below).
   */
  async acceptAudio(userId: string, file: UploadedAudio): Promise<IngestionRecord> {
    const objectKey = audioObjectKey(userId);

    await this.storage.put(objectKey, file.buffer, file.mimetype);

    const record = await this.prisma.ingestionRecord.create({
      data: { userId, objectKey, status: 'uploaded', enqueueCount: 1 },
    });

    try {
      await this.queue.enqueue(record.id, record.enqueueCount);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Stored ${objectKey} as ${record.id} but could not enqueue: ${message}`);

      return toContract(await this.markEnqueueFailed(record, message));
    }

    return toContract(record);
  }

  /**
   * Records why a stored upload never reached the queue.
   *
   * Its own failure is swallowed: the caller's upload did succeed, and losing
   * the database after the row was written is a bigger problem than this
   * bookkeeping. The unmodified row is returned so the response still names the
   * record the client can ask about.
   */
  private async markEnqueueFailed(
    record: PrismaIngestionRecord,
    message: string,
  ): Promise<PrismaIngestionRecord> {
    try {
      return await this.prisma.ingestionRecord.update({
        where: { id: record.id },
        // Retryable: nothing was sent to a provider, so a retry costs nothing
        // but the run that never happened. Not retried automatically, though —
        // the queue is the thing that is down.
        data: { status: 'failed', error: `enqueue failed: ${message}`, failureKind: 'retryable' },
      });
    } catch (error) {
      this.logger.error(
        `Could not mark ${record.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return record;
    }
  }

  /**
   * Puts a failed memo back through the pipeline, at the user's request.
   *
   * Any failed memo, `retryable` or `permanent`: the automatic policy is
   * cautious about spending money on a guess, but a person pressing Retry has
   * decided, and a fix shipped since (the Android 3GPP relabel) can turn a
   * permanent 400 into a transcript.
   *
   * The claim is one conditional update from `failed`, so two taps — or two
   * phones — start one run, not two. The transcript is left alone, so a memo
   * that failed at extraction resumes there rather than paying Whisper again.
   * The run's automatic-retry allowance starts over.
   *
   * 404 for a memo that is not the caller's, as everywhere. 409 for one that
   * is not `failed` — running, finished, or erased — because the request is
   * understood and the state is what is wrong.
   */
  async retry(userId: string, id: string): Promise<IngestionRecord> {
    const record = await this.prisma.ingestionRecord.findFirst({ where: { id, userId } });

    if (record === null) {
      throw new NotFoundException('Ingestion record not found');
    }

    if (record.deletedAt !== null) {
      throw new ConflictException('This memo was erased; there is nothing left to retry');
    }

    const claim = await this.prisma.ingestionRecord.updateMany({
      where: { id, userId, status: 'failed', deletedAt: null },
      data: {
        status: 'uploaded',
        error: null,
        failureKind: null,
        autoRetries: 0,
        enqueueCount: { increment: 1 },
      },
    });

    if (claim.count === 0) {
      throw new ConflictException(`Only a failed memo can be retried; this one is ${record.status}`);
    }

    const claimed = await this.prisma.ingestionRecord.findUniqueOrThrow({ where: { id } });

    try {
      await this.queue.enqueue(id, claimed.enqueueCount);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Retry of ${id} could not enqueue: ${message}`);

      return toContract(await this.markEnqueueFailed(claimed, message));
    }

    return toContract(claimed);
  }

  /** One record, scoped to its owner. */
  async findOne(userId: string, id: string): Promise<IngestionRecord | null> {
    // Scoped in the query, not checked after: an id belonging to someone else
    // has to be indistinguishable from one that does not exist.
    const record = await this.prisma.ingestionRecord.findFirst({ where: { id, userId } });

    return record === null ? null : toContract(record);
  }

  /**
   * The user's own uploads, newest first.
   *
   * Erased memos are left out: this is the working view, and a row the user
   * asked to be rid of has no business in it. The row itself stays reachable
   * through `findOne` — see there for why.
   */
  async list(userId: string): Promise<IngestionRecord[]> {
    const rows = await this.prisma.ingestionRecord.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(toContract);
  }

  /**
   * Erases a memo: the stored audio, the transcript, and the drafts nobody
   * confirmed. The row survives, stamped with `deletedAt`.
   *
   * Order is the whole safety argument. The object goes first, so a storage
   * failure aborts the request with the database untouched and the user free
   * to retry; `DeleteObject` succeeds on a key that is already gone, so the
   * retry works. Marking the row first and then failing would leave the file
   * in the bucket with nothing left pointing at it — the orphaned object this
   * route exists to prevent, now unreachable by any code path.
   *
   * What is *not* deleted: tasks the user approved, and the XP ledger. An
   * approved suggestion stopped being the memo's the moment a human adopted
   * it, and the XP behind it was legitimately earned — the ledger's task_id
   * nulls itself (ON DELETE SET NULL) rather than taking the row with it. If
   * deleting refunded XP, complete-earn-delete-repeat would be the cheapest XP
   * in the app.
   */
  async remove(userId: string, id: string): Promise<DeleteIngestionResult> {
    const record = await this.prisma.ingestionRecord.findFirst({ where: { id, userId } });

    if (record === null) {
      // Same 404-not-403 rule as everywhere else: ownership and existence stay
      // indistinguishable from outside.
      throw new NotFoundException('Ingestion record not found');
    }

    await this.storage.remove(record.objectKey);

    // The draft predicate, in SQL: `isTaskDraft` is source + confirmedAt, and
    // both halves have to be here or an approved task gets swept up with them.
    const draftsFromThisMemo = {
      ingestionRecordId: id,
      userId,
      source: 'ai_suggested' as const,
      confirmedAt: null,
    };

    const [deleted] = await this.prisma.$transaction([
      this.prisma.task.deleteMany({ where: draftsFromThisMemo }),
      this.prisma.ingestionRecord.update({
        where: { id },
        // The transcript is a copy of what the audio said, so erasing the audio
        // and keeping it would erase nothing. `status` and `error` stay: they
        // are the account of what happened, which is the point of the row that
        // remains.
        // `?? new Date()` keeps the *first* deletion's timestamp: a second
        // DELETE is a no-op that must not rewrite when the memo was erased.
        data: { deletedAt: record.deletedAt ?? new Date(), transcript: null },
      }),
    ]);

    return { id, deletedDrafts: deleted.count };
  }
}
