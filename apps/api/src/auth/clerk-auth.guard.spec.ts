import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsersService } from '../users/users.service.js';
import type { AuthenticatedRequest } from './clerk-auth.guard.js';
import { ClerkAuthGuard } from './clerk-auth.guard.js';

const getAuth = vi.hoisted(() => vi.fn());
vi.mock('@clerk/express', () => ({ getAuth }));

const CLERK_ID = 'user_2abcXYZ';
const LOCAL_ID = '11111111-1111-1111-1111-111111111111';

describe('ClerkAuthGuard', () => {
  let users: {
    upsertFromClerk: ReturnType<typeof vi.fn>;
    provisionDevUser: ReturnType<typeof vi.fn>;
  };
  let guard: ClerkAuthGuard;
  let request: AuthenticatedRequest;

  /** Only the two members the guard reaches for. */
  const context = (): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

  beforeEach(() => {
    getAuth.mockReset();
    users = { upsertFromClerk: vi.fn(), provisionDevUser: vi.fn() };
    guard = new ClerkAuthGuard(users as unknown as UsersService);
    request = {} as AuthenticatedRequest;
  });

  it('lets a Clerk failure surface instead of silently 401ing', async () => {
    // The bypass is off here, so a throw from getAuth is a genuine fault (a
    // misconfigured deployment, not an anonymous caller) and must not be
    // laundered into "please sign in", which would hide it behind a login wall.
    const fault = new Error('clerkMiddleware() was not run');
    getAuth.mockImplementation(() => {
      throw fault;
    });

    await expect(guard.canActivate(context())).rejects.toBe(fault);
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

  describe('development sign-in bypass', () => {
    const DEV_ID = '22222222-2222-2222-2222-222222222222';
    const originalNodeEnv = process.env.NODE_ENV;
    const originalBypass = process.env.DEV_AUTH_BYPASS;

    /** A request carrying a dev label, as the web client sends in dev mode. */
    const withDevHeader = (value: string): void => {
      request = { headers: { 'x-dev-user': value } } as unknown as AuthenticatedRequest;
    };

    beforeEach(() => {
      // Anonymous as far as Clerk is concerned: every pass below that reaches
      // the real path must therefore reject, which is what makes "the bypass
      // did not fire" observable rather than assumed.
      getAuth.mockReturnValue({ userId: null });
      users.provisionDevUser.mockResolvedValue({ id: DEV_ID, clerkId: 'dev_alice' });
      process.env.NODE_ENV = 'development';
      process.env.DEV_AUTH_BYPASS = 'true';
      withDevHeader('alice');
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalBypass === undefined) {
        delete process.env.DEV_AUTH_BYPASS;
      } else {
        process.env.DEV_AUTH_BYPASS = originalBypass;
      }
    });

    it('signs in as the labelled dev user when armed', async () => {
      await expect(guard.canActivate(context())).resolves.toBe(true);

      expect(users.provisionDevUser).toHaveBeenCalledWith('alice');
      expect(request.appUser).toEqual({ id: DEV_ID, clerkId: 'dev_alice' });
    });

    it('never consults Clerk on the bypass path', async () => {
      await guard.canActivate(context());

      // Which is the whole point: it has to work with placeholder keys.
      expect(getAuth).not.toHaveBeenCalled();
      expect(users.upsertFromClerk).not.toHaveBeenCalled();
    });

    it('is unreachable in a production build even when the flag is set', async () => {
      process.env.NODE_ENV = 'production';

      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.provisionDevUser).not.toHaveBeenCalled();
    });

    it('is off unless DEV_AUTH_BYPASS is explicitly true', async () => {
      delete process.env.DEV_AUTH_BYPASS;

      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.provisionDevUser).not.toHaveBeenCalled();
    });

    it('ignores a flag set to anything other than the exact string', async () => {
      process.env.DEV_AUTH_BYPASS = '1';

      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.provisionDevUser).not.toHaveBeenCalled();
    });

    it('still requires a real Clerk session when no header is sent', async () => {
      request = { headers: {} } as unknown as AuthenticatedRequest;

      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.provisionDevUser).not.toHaveBeenCalled();
    });

    it('401s rather than 500s when Clerk was never mounted', async () => {
      // main.ts leaves clerkMiddleware() off a dev server with no usable keys,
      // and getAuth then throws instead of reporting an empty session. Without
      // the tolerant branch this is a 500 on every guarded route.
      getAuth.mockImplementation(() => {
        throw new Error('clerkMiddleware() was not run');
      });
      request = { headers: {} } as AuthenticatedRequest;

      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it.each([
      ['a UUID belonging to someone else', LOCAL_ID],
      ['an injection-shaped label', "alice'; drop table users;--"],
      ['a label with a path separator', '../admin'],
      ['an over-long label', 'a'.repeat(33)],
      ['an empty label', '   '],
    ])('rejects %s rather than provisioning it', async (_case, value) => {
      withDevHeader(value);

      // A UUID is the notable one: the e2e stub accepts internal ids, and if
      // this path did too, an armed server would let a caller become any
      // existing user rather than only a persona the server itself creates.
      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.provisionDevUser).not.toHaveBeenCalled();
    });
  });
});
