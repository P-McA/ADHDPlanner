import { AUDIO_INGESTION_QUEUE, type AudioIngestionJob } from '@adhd/shared';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';

import { AudioIngestionProcessor } from './audio-ingestion.processor.js';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/**
 * Consumer side of the audio pipeline: BullMQ, and nothing else.
 *
 * All this does is decide *when* {@link AudioIngestionProcessor} runs. The
 * pipeline itself knows nothing about queues, which is what lets the tests
 * drive every state transition without Redis.
 *
 * It runs in the API process. That is a deliberate Phase 1 choice rather than
 * an oversight: one process is one thing to run, one place to read logs, and
 * `concurrency` below is the same backpressure a separate deployment would
 * give us. Splitting it out is a deployment change and no code change at all,
 * because the boundary is already the queue.
 */
@Injectable()
export class AudioIngestionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AudioIngestionWorker.name);
  private worker: Worker<AudioIngestionJob> | null = null;

  constructor(private readonly processor: AudioIngestionProcessor) {}

  onModuleInit(): void {
    if (process.env.INGESTION_WORKER_DISABLED === 'true') {
      // The e2e suite sets this. Tests drive the processor directly and assert
      // on the record; a live consumer racing them would make every assertion
      // about "what state is this record in" a coin toss.
      this.logger.log('Disabled by INGESTION_WORKER_DISABLED; jobs will wait in Redis');

      return;
    }

    this.worker = new Worker<AudioIngestionJob>(
      AUDIO_INGESTION_QUEUE,
      // The processor swallows pipeline failures into the record on purpose,
      // so a rejection here means the worker itself broke — exactly the case
      // BullMQ's retries should cover.
      (job) => this.processor.process(job.data.ingestionRecordId),
      {
        connection: {
          url: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
          maxRetriesPerRequest: null,
        },
        // Provider calls are slow and metered. Two at a time keeps a backlog
        // moving without turning a burst of uploads into a rate-limit wall.
        concurrency: 2,
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Job ${job?.id ?? 'unknown'} threw: ${error.message}`);
    });

    this.worker.on('error', (error) => {
      this.logger.warn(`Worker error: ${error.message}`);
    });

    this.logger.log(`Consuming ${AUDIO_INGESTION_QUEUE}`);
  }

  async onModuleDestroy(): Promise<void> {
    // Waits for in-flight jobs: killing a transcription mid-call would leave
    // the record on `transcribing` with nothing coming to move it.
    await this.worker?.close();
  }
}
