import { STREAK_FREEZE_CRON, STREAK_FREEZE_QUEUE } from '@adhd/shared';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

import { StreakFreezeService } from './streak-freeze.service.js';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/**
 * The clock behind the freeze sweep.
 *
 * Same split as the reminder worker: this decides *when* the sweep runs, and
 * the sweep itself takes an injected `now` so tests need no Redis. BullMQ
 * rather than an in-process timer for the same reason — two API instances
 * would otherwise both sweep, and the conditional write would make that safe
 * but wasteful.
 */
@Injectable()
export class StreakFreezeWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreakFreezeWorker.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(private readonly freezes: StreakFreezeService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.STREAK_FREEZE_WORKER_DISABLED === 'true') {
      this.logger.log('Disabled by STREAK_FREEZE_WORKER_DISABLED; no sweep will be scheduled');

      return;
    }

    const connection = {
      url: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
      maxRetriesPerRequest: null,
    };

    this.queue = new Queue(STREAK_FREEZE_QUEUE, { connection });
    this.queue.on('error', (error) => {
      this.logger.warn(`Queue error: ${error.message}`);
    });

    this.worker = new Worker(STREAK_FREEZE_QUEUE, () => this.freezes.runSweep(), {
      connection,
      concurrency: 1,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Freeze sweep ${job?.id ?? 'unknown'} threw: ${error.message}`);
    });

    this.worker.on('error', (error) => {
      this.logger.warn(`Worker error: ${error.message}`);
    });

    await this.queue.upsertJobScheduler('streak-freeze-sweep', { pattern: STREAK_FREEZE_CRON });

    this.logger.log(`Sweeping ${STREAK_FREEZE_QUEUE} on "${STREAK_FREEZE_CRON}"`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
