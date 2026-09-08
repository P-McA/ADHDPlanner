import { Module } from '@nestjs/common';

import { StorageModule } from '../storage/storage.module.js';
import { UsersModule } from '../users/users.module.js';
import { AudioIngestionQueue } from './audio-ingestion.queue.js';
import { IngestionController } from './ingestion.controller.js';
import { IngestionService } from './ingestion.service.js';

@Module({
  imports: [StorageModule, UsersModule],
  controllers: [IngestionController],
  providers: [IngestionService, AudioIngestionQueue],
})
export class IngestionModule {}
