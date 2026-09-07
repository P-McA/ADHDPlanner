import { getAuth } from '@clerk/express';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

import { UsersService } from '../users/users.service.js';

/**
 * The authenticated caller, resolved to an application user.
 *
 * `id` is the internal UUID that `tasks.user_id` references — controllers must
 * scope on this, never on the Clerk subject id.
 */
export interface AuthenticatedUser {
  id: string;
  clerkId: string;
}

/** Request augmented with the resolved user, set by {@link ClerkAuthGuard}. */
export interface AuthenticatedRequest extends Request {
  appUser?: AuthenticatedUser;
}

/**
 * Verifies the Clerk session and resolves it to a row in `users`.
 *
 * Clerk's middleware does the token verification; this guard's job is the
 * mapping from subject id to internal user, which every scoped query depends
 * on. It fails closed: no verified subject, or no matching user row, means 401
 * rather than an unscoped query.
 */
@Injectable()
export class ClerkAuthGuard implements CanActivate {
  constructor(private readonly users: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { userId } = getAuth(request);

    if (!userId) {
      throw new UnauthorizedException('No active Clerk session');
    }

    // Provisioned on demand: a caller whose first request is not GET /me still
    // gets a user row rather than a foreign key failure downstream.
    const user = await this.users.upsertFromClerk(userId);
    request.appUser = { id: user.id, clerkId: user.clerkId };

    return true;
  }
}
