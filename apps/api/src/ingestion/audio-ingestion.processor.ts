import type { DraftCandidate } from '@adhd/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IngestionRecord as PrismaIngestionRecord } from '@prisma/client';

import { EXTRACTOR, TRANSCRIBER, type Extractor, type Transcriber } from '../ai/ai.ports.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

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

    try {
      const transcript = await this.transcribe(record);
      await this.extractInto(record, transcript);
    } catch (error) {
      await this.fail(record, error);
    }
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
        await this.prisma.ingestionRecord.update({
          where: { id: record.id },
          data: { status: 'extracting' },
        });
      }

      return record.transcript;
    }

    await this.prisma.ingestionRecord.update({
      where: { id: record.id },
      data: { status: 'transcribing' },
    });

    const object = await this.storage.get(record.objectKey);
    const transcript = await this.transcriber.transcribe(object.body, object.contentType);

    // Stored before extraction runs, and kept even when extraction later finds
    // nothing: "we heard you, and there was no task in it" is a different
    // answer from "something broke", and the transcript is the only way the
    // user can check the machine heard them right.
    await this.prisma.ingestionRecord.update({
      where: { id: record.id },
      data: { transcript, status: 'extracting' },
    });

    return transcript;
  }

  /** Extracts candidates and writes them as drafts. */
  private async extractInto(record: PrismaIngestionRecord, transcript: string): Promise<void> {
    const candidates = await this.extractor.extract(transcript);

    // One transaction: either the record is `draft_created` and every draft
    // exists, or neither happened. A half-written batch would be re-created in
    // full on the next delivery, duplicating whatever landed the first time.
    await this.prisma.$transaction([
      ...candidates.map((candidate) =>
        this.prisma.task.create({ data: this.draftFrom(record, candidate) }),
      ),
      this.prisma.ingestionRecord.update({
        where: { id: record.id },
        data: { status: 'draft_created', error: null },
      }),
    ]);

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

  /** Parks the record on `failed` with the reason a human would need. */
  private async fail(record: PrismaIngestionRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    this.logger.error(`${record.id} failed: ${message}`);

    try {
      await this.prisma.ingestionRecord.update({
        where: { id: record.id },
        data: { status: 'failed', error: message },
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
