import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { UsersModule } from '../users/users.module.js';
import { AudioIngestionProcessor } from './audio-ingestion.processor.js';
import { AudioIngestionQueue } from './audio-ingestion.queue.js';
import { AudioIngestionWorker } from './audio-ingestion.worker.js';
import { IngestionController } from './ingestion.controller.js';
import { IngestionService } from './ingestion.service.js';

@Module({
  imports: [AiModule, StorageModule, UsersModule],
  controllers: [IngestionController],
  providers: [IngestionService, AudioIngestionQueue, AudioIngestionProcessor, AudioIngestionWorker],
  // Exported so the e2e suite can run the pipeline by hand, with the queue
  // consumer switched off — see AudioIngestionWorker.
  exports: [AudioIngestionProcessor],
})
export class IngestionModule {}
