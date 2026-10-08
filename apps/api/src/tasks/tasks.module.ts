import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module.js';
import { GamificationModule } from '../gamification/gamification.module.js';
import { UsersModule } from '../users/users.module.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

/** Imports UsersModule for ClerkAuthGuard, which every task route is behind. */
@Module({
  imports: [UsersModule, GamificationModule, AiModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
