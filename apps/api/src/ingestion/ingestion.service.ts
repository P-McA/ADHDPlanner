import type { IngestionRecord } from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';
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
    error: row.error,
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
   * state is inspectable rather than stranded. Re-queueing is a later concern.
   */
  async acceptAudio(userId: string, file: UploadedAudio): Promise<IngestionRecord> {
    const objectKey = audioObjectKey(userId);

    await this.storage.put(objectKey, file.buffer, file.mimetype);

    const record = await this.prisma.ingestionRecord.create({
      data: { userId, objectKey, status: 'uploaded' },
    });

    try {
      await this.queue.enqueue(record.id);
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
        data: { status: 'failed', error: `enqueue failed: ${message}` },
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

  /** One record, scoped to its owner. */
  async findOne(userId: string, id: string): Promise<IngestionRecord | null> {
    // Scoped in the query, not checked after: an id belonging to someone else
    // has to be indistinguishable from one that does not exist.
    const record = await this.prisma.ingestionRecord.findFirst({ where: { id, userId } });

    return record === null ? null : toContract(record);
  }

  /** The user's own uploads, newest first. */
  async list(userId: string): Promise<IngestionRecord[]> {
    const rows = await this.prisma.ingestionRecord.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(toContract);
  }
}
