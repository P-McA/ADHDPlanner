import { REMINDER_QUEUE, REMINDER_SWEEP_CRON } from '@adhd/shared';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

import { NotificationsService } from './notifications.service.js';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/**
 * The clock behind the reminder sweep, and nothing else.
 *
 * Same split as `AudioIngestionWorker`: this file decides *when*
 * {@link NotificationsService.runSweep} runs, and the sweep itself knows
 * nothing about queues, so every test drives it directly with an injected
 * `now` and no Redis at all.
 *
 * BullMQ rather than `@nestjs/schedule`, and that is a dependency argument as
 * much as a design one: BullMQ is already here for audio ingestion, and its job
 * scheduler puts the schedule in Redis. An in-process timer would fire once per
 * API instance, so scaling to two would double every reminder — a duplicate
 * push caused by an autoscaler, which is exactly the failure the dispatch
 * ledger exists to make impossible. Belt and braces: the ledger would catch it
 * even so.
 */
@Injectable()
export class ReminderWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReminderWorker.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(private readonly notifications: NotificationsService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.REMINDER_WORKER_DISABLED === 'true') {
      // The e2e suite sets this. Its tests call runSweep() themselves and then
      // assert what the dispatch ledger holds; a live sweep landing in the
      // middle would claim their notifications out from under them and every
      // assertion would become a race.
      this.logger.log('Disabled by REMINDER_WORKER_DISABLED; no sweep will be scheduled');

      return;
    }

    const connection = {
      url: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
      maxRetriesPerRequest: null,
    };

    this.queue = new Queue(REMINDER_QUEUE, { connection });
    this.queue.on('error', (error) => {
      this.logger.warn(`Queue error: ${error.message}`);
    });

    this.worker = new Worker(REMINDER_QUEUE, () => this.notifications.runSweep(), {
      connection,
      // One at a time. Two overlapping sweeps are safe — the dispatch ledger
      // makes them safe — but they would do the same work twice for nothing.
      concurrency: 1,
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Sweep ${job?.id ?? 'unknown'} threw: ${error.message}`);
    });

    this.worker.on('error', (error) => {
      this.logger.warn(`Worker error: ${error.message}`);
    });

    // A fixed scheduler id, so every restart and every additional instance
    // updates the same schedule rather than adding one more. Without it, a
    // rolling deploy would leave the old schedule running beside the new.
    await this.queue.upsertJobScheduler('reminder-sweep', { pattern: REMINDER_SWEEP_CRON });

    this.logger.log(`Sweeping ${REMINDER_QUEUE} on "${REMINDER_SWEEP_CRON}"`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
