import type { PushToken } from '@adhd/shared';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { RegisterPushTokenDto } from './dto/register-push-token.dto.js';
import { PushTokensService } from './push-tokens.service.js';

/**
 * Device registration, under `/me` like every other route that is about the
 * caller rather than about a resource.
 *
 * Scoped through `@CurrentUser()` throughout, so — as with `/me/stats` —
 * registering a device for somebody else is not a permissions failure, it is
 * unexpressible.
 */
@Controller('me/push-tokens')
@UseGuards(ClerkAuthGuard)
export class NotificationsController {
  constructor(private readonly pushTokens: PushTokensService) {}

  /** Every device currently set to receive this user's reminders. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<PushToken[]> {
    return this.pushTokens.list(user.id);
  }

  /**
   * Registers this device. 200, not 201, and deliberately.
   *
   * An app registers on every cold start, so the overwhelmingly common call is
   * the one that changes nothing. Answering 201 to it would claim a resource
   * was created when none was, and the client has no way to tell the difference
   * — nor any reason to care.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPushTokenDto,
  ): Promise<PushToken> {
    return this.pushTokens.register(user.id, dto.token);
  }

  /**
   * Stops sending to this device — signing out, or notifications turned off.
   *
   * The token travels in the body rather than the path because an Expo token
   * contains square brackets, and a route parameter carrying them is one
   * proxy's URL normalisation away from silently addressing something else.
   *
   * 204 whether or not a row matched. "Already gone" and "never yours" both
   * mean the user will not be notified on that device, which is what was asked
   * for; distinguishing them would confirm the existence of a token belonging
   * to someone else.
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async deregister(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPushTokenDto,
  ): Promise<void> {
    await this.pushTokens.deregister(user.id, dto.token);
  }
}
