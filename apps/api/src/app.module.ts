import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisService } from './redis/redis.service.js';
import { TasksModule } from './tasks/tasks.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [PrismaModule, UsersModule, TasksModule],
  controllers: [HealthController],
  providers: [RedisService],
})
export class AppModule {}
