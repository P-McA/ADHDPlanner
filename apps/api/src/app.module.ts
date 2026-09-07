import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller.js';
import { PrismaService } from './prisma/prisma.service.js';
import { RedisService } from './redis/redis.service.js';

@Module({
  controllers: [HealthController],
  providers: [PrismaService, RedisService],
})
export class AppModule {}
