import type { ActivityMetrics, EarnedBadge, User, UserStats } from '@adhd/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User as PrismaUser } from '@prisma/client';

import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { GamificationService } from '../gamification/gamification.service.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/clerk-auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActivityService } from './activity.service.js';
import { UpdateProfileDto } from './update-profile.dto.js';
import { UsersService } from './users.service.js';

/** Prisma row to wire contract. Dates become ISO strings to survive JSON. */
function toUser(row: PrismaUser): User {
  return {
    id: row.id,
    clerkId: row.clerkId,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    timezone: row.timezone,
    trackingMode: row.trackingMode,
    showElo: row.showElo,
    onboardedAt: row.onboardedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Controller('me')
@UseGuards(ClerkAuthGuard)
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gamification: GamificationService,
    private readonly users: UsersService,
    private readonly activityService: ActivityService,
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

    return toUser(row);
  }

  /**
   * Stores whichever profile fields the client sent.
   *
   * Its own route rather than fields on `/me/stats`, so the stats contract —
   * and every client fixture typed against it — is unchanged. The DTO rejects
   * anything Intl cannot resolve, and `forbidNonWhitelisted` rejects any other
   * profile field rather than silently ignoring it.
   */
  @Patch()
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<User> {
    return toUser(await this.users.updateProfile(user.id, dto));
  }

  /**
   * Marks the first-run explanation as seen. Idempotent, so a double tap or a
   * retry after a dropped response is harmless.
   */
  @Post('onboarded')
  @HttpCode(HttpStatus.OK)
  async onboarded(@CurrentUser() user: AuthenticatedUser): Promise<User> {
    return toUser(await this.users.markOnboarded(user.id));
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
   * Counts and performance rating for the metric view.
   *
   * Scoped through @CurrentUser() like every other route, so asking for
   * someone else's activity is unexpressible. The rating is derived from the
   * append-only event table, never from a stored balance.
   */
  @Get('activity')
  async activity(@CurrentUser() user: AuthenticatedUser): Promise<ActivityMetrics> {
    return this.activityService.getMetrics(user.id);
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
