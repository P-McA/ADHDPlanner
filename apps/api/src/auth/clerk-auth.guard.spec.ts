import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsersService } from '../users/users.service.js';
import type { AuthenticatedRequest } from './clerk-auth.guard.js';
import { ClerkAuthGuard } from './clerk-auth.guard.js';

const getAuth = vi.hoisted(() => vi.fn());
vi.mock('@clerk/express', () => ({ getAuth }));

const CLERK_ID = 'user_2abcXYZ';
const LOCAL_ID = '11111111-1111-1111-1111-111111111111';

describe('ClerkAuthGuard', () => {
  let users: { upsertFromClerk: ReturnType<typeof vi.fn> };
  let guard: ClerkAuthGuard;
  let request: AuthenticatedRequest;

  /** Only the two members the guard reaches for. */
  const context = (): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

  beforeEach(() => {
    getAuth.mockReset();
    users = { upsertFromClerk: vi.fn() };
    guard = new ClerkAuthGuard(users as unknown as UsersService);
    request = {} as AuthenticatedRequest;
  });

  it('rejects a request with no verified Clerk session', async () => {
    getAuth.mockReturnValue({ userId: null });

    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not provision a user when the session is missing', async () => {
    getAuth.mockReturnValue({ userId: null });

    await expect(guard.canActivate(context())).rejects.toThrow();
    expect(users.upsertFromClerk).not.toHaveBeenCalled();
    expect(request.appUser).toBeUndefined();
  });

  it('resolves the Clerk subject to a local user and attaches it', async () => {
    getAuth.mockReturnValue({ userId: CLERK_ID });
    users.upsertFromClerk.mockResolvedValue({ id: LOCAL_ID, clerkId: CLERK_ID });

    await expect(guard.canActivate(context())).resolves.toBe(true);

    expect(users.upsertFromClerk).toHaveBeenCalledWith(CLERK_ID);
    // The internal UUID, not the Clerk subject — tasks.user_id references this.
    expect(request.appUser).toEqual({ id: LOCAL_ID, clerkId: CLERK_ID });
  });

  it('fails closed rather than passing an unresolved request through', async () => {
    getAuth.mockReturnValue({ userId: CLERK_ID });
    users.upsertFromClerk.mockRejectedValue(new Error('clerk unreachable'));

    await expect(guard.canActivate(context())).rejects.toThrow('clerk unreachable');
    expect(request.appUser).toBeUndefined();
  });
});
