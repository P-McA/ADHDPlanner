import type { EarnedBadge, User, UserStats } from '@adhd/shared';
import { Controller, Get, NotFoundException, UseGuards } from '@nestjs/common';

import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { GamificationService } from '../gamification/gamification.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/clerk-auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('me')
@UseGuards(ClerkAuthGuard)
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gamification: GamificationService,
  ) {}

  /**
   * The authenticated user's profile.
   *
   * The guard has already provisioned the row, so this is a plain read; the
   * upsert-on-first-request behaviour lives there rather than here so it
   * applies to every authenticated route, not just this one.
   */
  @Get()
  async me(@CurrentUser() user: AuthenticatedUser): Promise<User> {
    const row = await this.prisma.user.findUnique({ where: { id: user.id } });

    if (!row) {
      throw new NotFoundException('User not found');
    }

    return {
      id: row.id,
      clerkId: row.clerkId,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatarUrl,
      timezone: row.timezone,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * XP, level and streak for the authenticated user.
   *
   * Scoped through @CurrentUser() like every other route, so there is no path
   * that takes a user id from the caller — asking for someone else's stats is
   * not a permissions failure, it is unexpressible.
   */
  @Get('stats')
  async stats(@CurrentUser() user: AuthenticatedUser): Promise<UserStats> {
    return this.gamification.getStats(user.id);
  }

  /**
   * The starter badges the authenticated user has earned, oldest first.
   *
   * Its own route rather than a field on /me/stats, so the stats contract —
   * and every client fixture typed against it — is unchanged.
   */
  @Get('badges')
  async badges(@CurrentUser() user: AuthenticatedUser): Promise<EarnedBadge[]> {
    return this.gamification.listBadges(user.id);
  }
}
