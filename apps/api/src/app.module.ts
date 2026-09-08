import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { RedisService } from './redis/redis.service.js';
import { StorageModule } from './storage/storage.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [PrismaModule, UsersModule, TasksModule, StorageModule, IngestionModule],
  controllers: [HealthController],
  providers: [RedisService],
})
export class AppModule {}
