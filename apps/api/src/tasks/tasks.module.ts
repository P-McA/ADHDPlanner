import { Module } from '@nestjs/common';

import { GamificationModule } from '../gamification/gamification.module.js';
import { UsersModule } from '../users/users.module.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

/** Imports UsersModule for ClerkAuthGuard, which every task route is behind. */
@Module({
  imports: [UsersModule, GamificationModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
