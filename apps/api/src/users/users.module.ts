import { Module } from '@nestjs/common';

import { GamificationModule } from '../gamification/gamification.module.js';

import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

/**
 * Owns the Clerk-to-local-user projection.
 *
 * ClerkAuthGuard lives here rather than in an auth module of its own because
 * its one dependency is UsersService; exporting it lets feature modules guard
 * their controllers without reaching for the service directly.
 */
@Module({
  imports: [GamificationModule],
  controllers: [UsersController],
  providers: [UsersService, ClerkAuthGuard],
  exports: [UsersService, ClerkAuthGuard],
})
export class UsersModule {}
