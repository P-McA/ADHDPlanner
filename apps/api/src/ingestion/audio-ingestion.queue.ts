import { AUDIO_INGESTION_QUEUE, type AudioIngestionJob } from '@adhd/shared';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

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

  /** Enqueues one record for transcription. */
  async enqueue(ingestionRecordId: string): Promise<void> {
    await this.queue.add(
      'transcribe',
      { ingestionRecordId },
      // De-duplicated on the record id: an at-least-once delivery or a
      // client retry must not put the same upload through the pipeline twice.
      { jobId: ingestionRecordId },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
