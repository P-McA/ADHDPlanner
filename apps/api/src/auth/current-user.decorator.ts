import { InternalServerErrorException, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest, AuthenticatedUser } from './clerk-auth.guard.js';

/**
 * Injects the authenticated application user.
 *
 * Throws rather than returning undefined when the guard has not run: a
 * controller that reads this without {@link ClerkAuthGuard} would otherwise
 * silently query with `userId: undefined`, which Prisma treats as "no filter"
 * — every user's tasks. Failing loudly is the point.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.appUser) {
      throw new InternalServerErrorException(
        'CurrentUser used on a route without ClerkAuthGuard',
      );
    }

    return request.appUser;
  },
);
