import { Module } from '@nestjs/common';

import { GamificationService } from './gamification.service.js';
import { StreakFreezeService } from './streak-freeze.service.js';
import { StreakFreezeWorker } from './streak-freeze.worker.js';

/**
 * Exported rather than global: TasksModule needs it to award on completion and
 * UsersModule needs it for GET /me/stats, and naming those two edges is more
 * informative than making it ambient.
 */
@Module({
  providers: [GamificationService, StreakFreezeService, StreakFreezeWorker],
  exports: [GamificationService, StreakFreezeService],
})
export class GamificationModule {}
