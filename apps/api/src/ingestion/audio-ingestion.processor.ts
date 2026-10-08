import { AUTO_RETRY_DELAYS_MS, MAX_AUTO_RETRIES, type DraftCandidate } from '@adhd/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IngestionRecord as PrismaIngestionRecord } from '@prisma/client';

import { EXTRACTOR, TRANSCRIBER, type Extractor, type Transcriber } from '../ai/ai.ports.js';
import { classifyFailure } from '../ai/provider-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { AudioIngestionQueue } from './audio-ingestion.queue.js';

/**
 * A record this pipeline may still write to: not erased, and not settled.
 *
 * Every write after the first read carries this in its WHERE clause, because
 * the up-front check is only a snapshot. Between it and the write, a 60 s
 * transcription is long enough for the user to erase the memo, or for a
 * redelivered copy of the same job to finish first. The row lock taken by the
 * conditional update is what serialises those, not the order this code
 * happens to run in.
 */
const STILL_OPEN = {
  deletedAt: null,
  status: { notIn: ['draft_created' as const, 'failed' as const] },
};

/**
 * Thrown when a guarded write matched nothing: an erase, or the other copy of
 * this job, already decided the record's fate. Not a failure — there is
 * nothing to record and nothing to retry.
 */
class RecordClosed extends Error {}

/**
 * The pipeline: bytes in object storage → transcript → task drafts.
 *
 * Deliberately separate from the BullMQ subscription in
 * `audio-ingestion.worker.ts`. This class is a plain injectable that takes a
 * record id, so the tests drive the whole state machine without a queue, and
 * the queue is reduced to the one thing it does — deciding when to call this.
 *
 * Two rules shape everything below.
 *
 * **Every transition is a database write.** The record, not the job, is the
 * source of truth: a worker killed mid-transcription leaves a row parked on
 * `transcribing`, which is a fact someone can look at, rather than a job that
 * evaporated.
 *
 * **It ends in drafts, never in tasks.** The rows created here are
 * `ai_suggested` with `confirmedAt` null — drafts by the definition in
 * `isTaskDraft` — and nothing in this file can produce a confirmed task. That
 * is the human-in-the-loop fence, and it is load-bearing.
 */
@Injectable()
export class AudioIngestionProcessor {
  private readonly logger = new Logger(AudioIngestionProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(TRANSCRIBER) private readonly transcriber: Transcriber,
    @Inject(EXTRACTOR) private readonly extractor: Extractor,
    private readonly queue: AudioIngestionQueue,
  ) {}

  /**
   * Runs one record through to `draft_created` or `failed`.
   *
   * Never throws for a provider or storage failure — it records one. Throwing
   * would hand the job back to BullMQ's retry policy, and retrying a provider
   * call is the wrong default here: a memo that failed to transcribe will
   * usually fail identically, a hung call already burned its timeout, and
   * re-running transcription on 25 MB of audio costs real money for the same
   * answer. The record ends `failed` with the reason, and re-processing is an
   * explicit action someone takes later. The queue's `attempts` therefore only
   * ever fires for a *crashed* worker, which is the case it should cover.
   */
  async process(ingestionRecordId: string): Promise<void> {
    const record = await this.prisma.ingestionRecord.findUnique({
      where: { id: ingestionRecordId },
    });

    if (record === null) {
      // The row is the work. No row, nothing to do — and re-queuing would only
      // spin. This happens if a record is deleted while its job is waiting.
      this.logger.warn(`Job for ${ingestionRecordId} has no record; dropping it`);

      return;
    }

    if (record.status === 'draft_created' || record.status === 'failed') {
      // Terminal. A duplicate delivery of a finished record must not run the
      // pipeline again and double the user's drafts.
      this.logger.log(`${record.id} is already ${record.status}; nothing to do`);

      return;
    }

    if (record.deletedAt !== null) {
      // Erased while the job was waiting. The audio is gone on purpose, so
      // running on would only park the record on `failed` with a storage error
      // about an object the user deliberately removed.
      this.logger.log(`${record.id} was erased before it ran; nothing to do`);

      return;
    }

    try {
      const transcript = await this.transcribe(record);
      await this.extractInto(record, transcript);
    } catch (error) {
      if (error instanceof RecordClosed) {
        this.logger.log(`${record.id} was closed by someone else mid-pipeline; stopping`);

        return;
      }

      await this.fail(record, error);
    }
  }

  /**
   * Moves a record forward only if it is still open, and stops the pipeline
   * if it is not. A plain `update` here would write a transcript back onto a
   * memo the user erased during the provider call.
   */
  private async advance(
    record: PrismaIngestionRecord,
    data: { status: 'transcribing' | 'extracting'; transcript?: string },
  ): Promise<void> {
    const { count } = await this.prisma.ingestionRecord.updateMany({
      where: { id: record.id, ...STILL_OPEN },
      data,
    });

    if (count === 0) throw new RecordClosed();
  }

  /**
   * Fetches the audio and transcribes it, storing the result.
   *
   * Leaves the record on `extracting` either way, so the caller never has to
   * reason about which path got it there.
   *
   * Resumable: a record that already has a transcript skips straight past the
   * provider call, so a crash between "transcript stored" and "drafts created"
   * costs a cheap extraction on redelivery rather than a second Whisper call
   * on the same audio.
   */
  private async transcribe(record: PrismaIngestionRecord): Promise<string> {
    if (record.transcript !== null) {
      this.logger.log(`${record.id} already has a transcript; resuming at extraction`);

      if (record.status !== 'extracting') {
        await this.advance(record, { status: 'extracting' });
      }

      return record.transcript;
    }

    await this.advance(record, { status: 'transcribing' });

    const object = await this.storage.get(record.objectKey);
    const transcript = await this.transcriber.transcribe(object.body, object.contentType);

    // Stored before extraction runs, and kept even when extraction later finds
    // nothing: "we heard you, and there was no task in it" is a different
    // answer from "something broke", and the transcript is the only way the
    // user can check the machine heard them right.
    await this.advance(record, { transcript, status: 'extracting' });

    return transcript;
  }

  /**
   * Puts the record back on `uploaded` and queues the next try after a delay.
   *
   * The claim is conditional like every other write, and it bumps
   * `enqueueCount` in the same statement, so the delayed job gets an id BullMQ
   * has never seen. If the record was closed meanwhile (erased, or another copy
   * settled it) nothing is scheduled. The error stays on the row while the retry
   * waits, so "slow" and "struggling" look different from outside.
   *
   * If the enqueue itself fails, the record is parked on `failed` rather than
   * left on `uploaded` with nothing coming for it — the same rule the upload
   * route keeps.
   */
  private async scheduleRetry(record: PrismaIngestionRecord, message: string): Promise<void> {
    const attempt = record.autoRetries + 1;
    const claim = await this.prisma.ingestionRecord.updateMany({
      where: { id: record.id, ...STILL_OPEN },
      data: {
        status: 'uploaded',
        error: message,
        autoRetries: { increment: 1 },
        enqueueCount: { increment: 1 },
      },
    });

    if (claim.count === 0) {
      this.logger.log(`${record.id} was closed before its retry could be scheduled`);

      return;
    }

    const delay = AUTO_RETRY_DELAYS_MS[attempt - 1] ?? AUTO_RETRY_DELAYS_MS.at(-1) ?? 0;

    this.logger.warn(
      `${record.id} hit a retryable failure; retry ${attempt}/${MAX_AUTO_RETRIES} in ${delay} ms: ${message}`,
    );

    try {
      await this.queue.enqueue(record.id, record.enqueueCount + 1, delay);
    } catch (enqueueError) {
      const reason = enqueueError instanceof Error ? enqueueError.message : String(enqueueError);

      await this.prisma.ingestionRecord.updateMany({
        where: { id: record.id, ...STILL_OPEN },
        data: { status: 'failed', error: `${message} (retry not queued: ${reason})`, failureKind: 'retryable' },
      });
    }
  }

  /** Extracts candidates and writes them as drafts. */
  private async extractInto(record: PrismaIngestionRecord, transcript: string): Promise<void> {
    const candidates = await this.extractor.extract(transcript);

    // One transaction: either the record is `draft_created` and every draft
    // exists, or neither happened. A half-written batch would be re-created in
    // full on the next delivery, duplicating whatever landed the first time.
    //
    // The claim comes *first* and is conditional. Two overlapping deliveries
    // both reach this point having passed every earlier check; the row lock
    // makes the second claim wait for the first to commit, then re-read the
    // row, find it settled, and match nothing. Only the winner creates drafts.
    // The same condition stops an erase that landed during extraction.
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.ingestionRecord.updateMany({
        where: { id: record.id, ...STILL_OPEN },
        data: { status: 'draft_created', error: null },
      });

      if (claim.count === 0) throw new RecordClosed();

      for (const candidate of candidates) {
        await tx.task.create({ data: this.draftFrom(record, candidate) });
      }
    });

    this.logger.log(`${record.id} produced ${candidates.length} draft(s)`);
  }

  /**
   * One candidate as a draft row.
   *
   * `source` and `confirmedAt` are not derived from anything the model said —
   * they are fixed here, so no extraction output can produce a task that is
   * already confirmed.
   */
  private draftFrom(record: PrismaIngestionRecord, candidate: DraftCandidate) {
    return {
      userId: record.userId,
      title: candidate.title,
      source: 'ai_suggested' as const,
      confirmedAt: null,
      ingestionRecordId: record.id,
      dueAt: candidate.dueAt === null ? null : new Date(candidate.dueAt),
      // Absent priority means the speaker did not signal one; the column's own
      // default (`med`) is the honest answer, not a guess dressed up as data.
      ...(candidate.manualPriority === null ? {} : { manualPriority: candidate.manualPriority }),
    };
  }

  /**
   * Decides what a failure means: another try later, or `failed` for a human.
   *
   * A `retryable` failure with allowance left goes back to `uploaded` with a
   * delayed job; anything else parks on `failed` with its kind. The processor
   * still never throws — the retry is a new job it schedules, not a rejection
   * handed to BullMQ, so this one policy owns every automatic retry and the
   * queue's own `attempts` still only ever covers a crashed worker.
   */
  private async fail(record: PrismaIngestionRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const kind = classifyFailure(error);

    try {
      if (kind === 'retryable' && record.autoRetries < MAX_AUTO_RETRIES) {
        await this.scheduleRetry(record, message);

        return;
      }

      this.logger.error(`${record.id} failed (${kind}): ${message}`);

      // Guarded like every other write: a provider failure in the losing copy
      // of an overlapping job must not overwrite the winner's `draft_created`,
      // and an erased record keeps the status it was erased with.
      await this.prisma.ingestionRecord.updateMany({
        where: { id: record.id, ...STILL_OPEN },
        data: { status: 'failed', error: message, failureKind: kind },
      });
    } catch (writeError) {
      // The database is the only place this could have been recorded, so all
      // that is left is to say so loudly. Swallowed rather than rethrown: the
      // job retrying would hit the same dead database.
      this.logger.error(
        `Could not mark ${record.id} failed: ${
          writeError instanceof Error ? writeError.message : String(writeError)
        }`,
      );
    }
  }
}
