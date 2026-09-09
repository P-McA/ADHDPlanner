import type { ExecutionContext } from '@nestjs/common';
import { Logger, UnauthorizedException } from '@nestjs/common';
import type { MockInstance } from 'vitest';
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
  /**
   * Stubbed for every test, not just the ones that assert on it: the guard
   * logs a real error when Clerk cannot be read, and several cases below
   * exercise exactly that. Left live it prints stack traces into a passing run.
   */
  let loggedError: MockInstance<Logger['error']>;

  /** Only the two members the guard reaches for. */
  const context = (): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

  beforeEach(() => {
    getAuth.mockReset();
    loggedError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    users = { upsertFromClerk: vi.fn(), provisionDevUser: vi.fn() };
    guard = new ClerkAuthGuard(users as unknown as UsersService);
    request = {} as AuthenticatedRequest;
  });

  afterEach(() => {
    loggedError.mockRestore();
  });

  it('answers 401, not 500, when the Clerk context cannot be read at all', async () => {
    // This test used to assert the opposite — that the fault surfaced — on the
    // argument that a misconfigured deployment is not an anonymous caller. The
    // fault is still not laundered away (see the next test), but the caller's
    // answer is 401: a 500 tells every user, and every stranger, that the
    // server is misconfigured, and tells the operator nothing a log would not.
    getAuth.mockImplementation(() => {
      throw new Error('clerkMiddleware() was not run');
    });

    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('says so loudly in the log rather than swallowing the misconfiguration', async () => {
    // The half of the old behaviour worth keeping. Without this the change
    // above turns "nobody can sign in, and nothing anywhere says why" into the
    // supported outcome.
    getAuth.mockImplementation(() => {
      throw new Error('clerkMiddleware() was not run');
    });

    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);

    expect(loggedError).toHaveBeenCalledTimes(1);
    expect(loggedError.mock.calls[0]?.[0]).toContain('treating the request as unauthenticated');
  });

  it('does not log a fault for an ordinary signed-out request', async () => {
    // An anonymous caller is the normal case and must not fill the log with
    // errors — which is what makes the line above worth reading when it appears.
    getAuth.mockReturnValue({ userId: null });

    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(loggedError).not.toHaveBeenCalled();
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
      // main.ts leaves clerkMiddleware() off a server with no usable key, and
      // getAuth then throws instead of reporting an empty session. The armed
      // bypass does not help here: no header was sent, so this falls through to
      // the real path and has to fail closed on its own.
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
