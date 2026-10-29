import { WEEKLY_DIGEST_CRON, WEEKLY_DIGEST_QUEUE } from '@adhd/shared';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

import { WeeklyDigestService } from './weekly-digest.service.js';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/** The clock behind the digest sweep; the sweep itself takes an injected `now`. */
@Injectable()
export class WeeklyDigestWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WeeklyDigestWorker.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(private readonly digests: WeeklyDigestService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.WEEKLY_DIGEST_WORKER_DISABLED === 'true') {
      this.logger.log('Disabled by WEEKLY_DIGEST_WORKER_DISABLED; no sweep will be scheduled');

      return;
    }

    const connection = {
      url: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
      maxRetriesPerRequest: null,
    };

    this.queue = new Queue(WEEKLY_DIGEST_QUEUE, { connection });
    this.queue.on('error', (error) => {
      this.logger.warn(`Queue error: ${error.message}`);
    });

    this.worker = new Worker(WEEKLY_DIGEST_QUEUE, () => this.digests.runSweep(), {
      connection,
      concurrency: 1,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Digest sweep ${job?.id ?? 'unknown'} threw: ${error.message}`);
    });

    this.worker.on('error', (error) => {
      this.logger.warn(`Worker error: ${error.message}`);
    });

    await this.queue.upsertJobScheduler('weekly-digest-sweep', { pattern: WEEKLY_DIGEST_CRON });

    this.logger.log(`Sweeping ${WEEKLY_DIGEST_QUEUE} on "${WEEKLY_DIGEST_CRON}"`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
