import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { PushReceipt } from './notifications.ports.js';
import { PushTokensService } from './push-tokens.service.js';

/**
 * The registration rules, asserted on the query rather than on the database.
 *
 * That split is deliberate and matches Milestone A: what actually lands in
 * Postgres is proved in `test/notifications.e2e-spec.ts`, because a mocked
 * client agrees with whatever the service does. What is worth pinning *here*
 * is the shape of the request — specifically the `where` clause of the delete,
 * which is the one line standing between a rate limit and an unsubscribed user.
 */

const row = {
  id: 'token-row-id',
  token: 'ExponentPushToken[abc]',
  createdAt: new Date('2026-09-09T10:00:00.000Z'),
  updatedAt: new Date('2026-09-09T10:00:00.000Z'),
};

let prisma: {
  pushToken: {
    upsert: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
};
let service: PushTokensService;

beforeEach(() => {
  prisma = {
    pushToken: {
      upsert: vi.fn().mockResolvedValue(row),
      findMany: vi.fn().mockResolvedValue([row]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };

  service = new PushTokensService(prisma as unknown as PrismaService);
});

const receipt = (token: string, reason?: PushReceipt['reason']): PushReceipt =>
  reason ? { token, ok: false, reason } : { token, ok: true };

describe('PushTokensService.register', () => {
  it('upserts on the token, so a handed-on phone moves rather than duplicating', async () => {
    await service.register('user-1', 'ExponentPushToken[abc]');

    // Keyed on the token alone. Keyed on (userId, token) instead, the previous
    // owner's row would survive and their reminders would keep arriving on a
    // phone that is now somebody else's — with every send succeeding, so
    // nothing in the system would ever notice.
    expect(prisma.pushToken.upsert).toHaveBeenCalledWith({
      where: { token: 'ExponentPushToken[abc]' },
      create: { userId: 'user-1', token: 'ExponentPushToken[abc]' },
      update: { userId: 'user-1' },
    });
  });

  it('returns ISO timestamps, not Dates', async () => {
    const result = await service.register('user-1', 'ExponentPushToken[abc]');

    expect(result.createdAt).toBe('2026-09-09T10:00:00.000Z');
  });
});

describe('PushTokensService.deregister', () => {
  it('scopes the delete to the caller', async () => {
    await service.deregister('user-1', 'ExponentPushToken[abc]');

    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: 'ExponentPushToken[abc]' },
    });
  });
});

describe('PushTokensService.pruneDeadTokens', () => {
  it('deletes a registration the provider says is gone for good', async () => {
    const count = await service.pruneDeadTokens('user-1', [
      receipt('dead', 'device_not_registered'),
    ]);

    expect(count).toBe(1);
    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: { in: ['dead'] } },
    });
  });

  it.each([
    ['message_rate_exceeded'],
    ['transport'],
    ['invalid_credentials'],
    ['message_too_big'],
    ['unknown'],
  ] as const)('deletes nothing on a %s failure', async (reason) => {
    // Every one of these describes a bad moment, not a dead device. Deleting
    // here would silently unsubscribe a blameless user, and registration only
    // happens on the phone at app start — so they would not find out until
    // they next opened the app, if ever.
    await service.pruneDeadTokens('user-1', [receipt('good', reason)]);

    expect(prisma.pushToken.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes only the dead device out of a mixed batch', async () => {
    await service.pruneDeadTokens('user-1', [
      receipt('alive'),
      receipt('dead', 'device_not_registered'),
      receipt('busy', 'message_rate_exceeded'),
    ]);

    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', token: { in: ['dead'] } },
    });
  });

  it('scopes the delete to the user the sweep was sending for', async () => {
    await service.pruneDeadTokens('user-1', [receipt('dead', 'device_not_registered')]);

    // The race this closes: the device is handed on and re-registered to
    // somebody else between the token read and the send. The receipt is about
    // the old owner, and deleting by token alone would take the new owner's
    // fresh registration with it.
    const call = prisma.pushToken.deleteMany.mock.calls[0] as [{ where: { userId?: string } }];
    expect(call[0].where.userId).toBe('user-1');
  });

  it('does not go to the database at all when everything was delivered', async () => {
    expect(await service.pruneDeadTokens('user-1', [receipt('a'), receipt('b')])).toBe(0);
    expect(prisma.pushToken.deleteMany).not.toHaveBeenCalled();
  });
});
