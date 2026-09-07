import { Module } from '@nestjs/common';

import { GamificationService } from './gamification.service.js';

/**
 * Exported rather than global: TasksModule needs it to award on completion and
 * UsersModule needs it for GET /me/stats, and naming those two edges is more
 * informative than making it ambient.
 */
@Module({
  providers: [GamificationService],
  exports: [GamificationService],
})
export class GamificationModule {}
