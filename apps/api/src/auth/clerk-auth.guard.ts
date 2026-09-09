import { getAuth } from '@clerk/express';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
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
 * Header carrying a development user label when the bypass below is armed.
 *
 * A label ("alice"), not an internal id: the caller names a persona and the
 * server resolves it to a row it provisions itself. Accepting an internal UUID
 * here — as the e2e stub does, where it is safe because the guard is replaced
 * wholesale by DI — would let anyone who could reach an armed server assert
 * any existing user's identity.
 */
export const DEV_USER_HEADER = 'x-dev-user';

/**
 * Whether the development sign-in bypass is available.
 *
 * Two independent conditions, both required, read fresh on every request so a
 * misconfigured process cannot arm it after the fact:
 *
 * 1. `NODE_ENV` is not `production`. Next.js and Nest both set this in a real
 *    build, so the bypass is unreachable in production even if (1) is the only
 *    thing standing, and no deployment flag can turn it back on.
 * 2. `DEV_AUTH_BYPASS` is exactly `'true'`. Off unless someone opts in, so a
 *    plain `pnpm dev` with no env file still exercises the real Clerk path.
 *
 * Note this is deliberately a server-side variable. `NEXT_PUBLIC_*` values are
 * inlined into the browser bundle and are trivially forged, so they can gate
 * what the *client* sends but must never gate what the *API* trusts.
 */
export function devBypassArmed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true';
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
  private readonly logger = new Logger(ClerkAuthGuard.name);

  constructor(private readonly users: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const devLabel = this.devUserLabel(request);
    if (devLabel !== null) {
      const user = await this.users.provisionDevUser(devLabel);
      request.appUser = { id: user.id, clerkId: user.clerkId };

      return true;
    }

    const userId = this.clerkSubject(request);

    if (userId === null) {
      throw new UnauthorizedException('No active Clerk session');
    }

    // Provisioned on demand: a caller whose first request is not GET /me still
    // gets a user row rather than a foreign key failure downstream.
    const user = await this.users.upsertFromClerk(userId);
    request.appUser = { id: user.id, clerkId: user.clerkId };

    return true;
  }

  /**
   * The verified Clerk subject, or null when there is no session.
   *
   * `getAuth` does not report "no session" by returning an empty one in every
   * case: when `clerkMiddleware()` was never mounted it *throws*
   * ("clerkMiddleware should be registered before using getAuth"). Both
   * outcomes mean the same thing to a caller — this request carries no
   * identity this server can verify — so both become 401 here.
   *
   * This used to catch only while the dev bypass was armed, and let the throw
   * escape otherwise, on the argument that a fault is not an anonymous caller
   * and should not be laundered into "please sign in". The argument was right
   * about the fault and wrong about the remedy: a 500 is not how an operator
   * finds out, it is only how every caller finds out, and answering 500 to an
   * unauthenticated request also tells an anonymous stranger that the server is
   * misconfigured. The fault is loud in the log instead, at error level, where
   * it belongs; the wire answer stays 401 and stays fail-closed.
   */
  private clerkSubject(request: AuthenticatedRequest): string | null {
    try {
      return getAuth(request).userId ?? null;
    } catch (error: unknown) {
      // Not swallowed: this is a misconfigured server, not a signed-out user,
      // and the distinction has to survive somewhere. See the note above.
      this.logger.error(
        'Clerk session could not be read; treating the request as unauthenticated. ' +
          'This usually means clerkMiddleware() is not mounted, or CLERK_PUBLISHABLE_KEY / ' +
          'CLERK_SECRET_KEY are missing or malformed.',
        error instanceof Error ? error.stack : String(error),
      );

      return null;
    }
  }

  /**
   * The development label to sign in as, or null to use the real Clerk path.
   *
   * Null unless the bypass is armed *and* the header carries a usable label, so
   * the fallthrough is always the genuine session check.
   */
  private devUserLabel(request: AuthenticatedRequest): string | null {
    if (!devBypassArmed()) {
      return null;
    }

    const header = request.headers[DEV_USER_HEADER];
    if (typeof header !== 'string') {
      return null;
    }

    // Constrained rather than free-form: the label becomes part of a clerk_id
    // and an email address, so anything outside this set has no business
    // reaching the database.
    const label = header.trim();

    return /^[a-z0-9_-]{1,32}$/i.test(label) ? label : null;
  }
}
