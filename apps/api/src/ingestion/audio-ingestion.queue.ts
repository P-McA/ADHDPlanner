import { AUDIO_INGESTION_QUEUE, type AudioIngestionJob } from '@adhd/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/** The BullMQ job id for one enqueue of one record. See `enqueue`. */
export function ingestionJobId(ingestionRecordId: string, enqueueCount: number): string {
  return `${ingestionRecordId}_${enqueueCount}`;
}

/**
 * Producer side of the audio pipeline. The consumer is Milestone B.
 *
 * The job carries only the record id. The transcript, the object key and the
 * status all live in `ingestion_records`, so a job that is retried or
 * delivered twice reads current state rather than acting on a stale copy
 * embedded in the payload.
 */
@Injectable()
export class AudioIngestionQueue implements OnModuleDestroy {
  private readonly logger = new Logger(AudioIngestionQueue.name);
  private readonly queue: Queue<AudioIngestionJob>;

  constructor() {
    this.queue = new Queue<AudioIngestionJob>(AUDIO_INGESTION_QUEUE, {
      connection: {
        url: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
        // Matches RedisService: an unreachable Redis should surface as a
        // failure to enqueue, not an unbounded reconnect storm.
        maxRetriesPerRequest: null,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        // Kept briefly after success so a run can be inspected; failures are
        // kept far longer, because those are the ones anyone goes looking for.
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 24 * 3600 },
      },
    });

    this.queue.on('error', (error) => {
      this.logger.warn(`Queue error: ${error.message}`);
    });
  }

  /**
   * Enqueues one run of a record through the pipeline.
   *
   * The job id is the record id *and* which enqueue this is
   * (`ingestion_records.enqueue_count`). De-duplicated per enqueue: an
   * at-least-once delivery of the same add still collapses to one job. But not
   * per record, because BullMQ silently ignores an add whose id it still holds
   * — and it keeps a finished job for an hour and a failed one for a day — so a
   * retry reusing the bare record id would be accepted, return normally, and
   * never run. `_`, not `:`, because BullMQ reserves `:` in custom ids.
   */
  async enqueue(ingestionRecordId: string, enqueueCount: number, delayMs = 0): Promise<void> {
    await this.queue.add(
      'transcribe',
      { ingestionRecordId },
      { jobId: ingestionJobId(ingestionRecordId, enqueueCount), delay: delayMs },
    );
  }

  /** Test seam: the job for one enqueue, or undefined if BullMQ holds none. */
  async getJob(ingestionRecordId: string, enqueueCount: number) {
    return this.queue.getJob(ingestionJobId(ingestionRecordId, enqueueCount));
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
