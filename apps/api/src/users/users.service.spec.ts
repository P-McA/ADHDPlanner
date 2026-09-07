import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

const getUser = vi.hoisted(() => vi.fn());
vi.mock('@clerk/express', () => ({ clerkClient: { users: { getUser } } }));

const CLERK_ID = 'user_2abcXYZ';
const LOCAL_ID = '11111111-1111-1111-1111-111111111111';

/** The slice of a Clerk profile that upsertFromClerk reads. */
function profile(overrides: Record<string, unknown> = {}) {
  return {
    primaryEmailAddress: { emailAddress: 'primary@example.com' },
    emailAddresses: [{ emailAddress: 'fallback@example.com' }],
    firstName: 'Ada',
    lastName: 'Lovelace',
    imageUrl: 'https://img.clerk.example/ada.png',
    ...overrides,
  };
}

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    getUser.mockReset();
    prisma = { user: { findUnique: vi.fn(), upsert: vi.fn() } };

    const moduleRef = await Test.createTestingModule({ providers: [UsersService] })
      .useMocker((token) => (token === PrismaService ? prisma : undefined))
      .compile();

    service = moduleRef.get(UsersService);
  });

  /** The `create` payload of the single upsert call. */
  const createArg = (): Record<string, unknown> => {
    const call = prisma.user.upsert.mock.calls[0] as [{ create: Record<string, unknown> }];
    return call[0].create;
  };

  it('returns the existing user without calling Clerk', async () => {
    const existing = { id: LOCAL_ID, clerkId: CLERK_ID };
    prisma.user.findUnique.mockResolvedValue(existing);

    await expect(service.upsertFromClerk(CLERK_ID)).resolves.toBe(existing);

    // The hot path: only the very first request for a subject should pay for
    // the Clerk round-trip.
    expect(getUser).not.toHaveBeenCalled();
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('provisions a user from the Clerk profile on first sight', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    getUser.mockResolvedValue(profile());
    prisma.user.upsert.mockResolvedValue({ id: LOCAL_ID, clerkId: CLERK_ID });

    await service.upsertFromClerk(CLERK_ID);

    expect(getUser).toHaveBeenCalledWith(CLERK_ID);
    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { clerkId: CLERK_ID },
      create: {
        clerkId: CLERK_ID,
        email: 'primary@example.com',
        name: 'Ada Lovelace',
        avatarUrl: 'https://img.clerk.example/ada.png',
      },
      update: {},
    });
  });

  it('upserts rather than creates, so concurrent first requests cannot race', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    getUser.mockResolvedValue(profile());
    prisma.user.upsert.mockResolvedValue({ id: LOCAL_ID, clerkId: CLERK_ID });

    await service.upsertFromClerk(CLERK_ID);

    // Two requests losing the findUnique race must not fail the clerk_id
    // unique constraint; `update: {}` makes the second a no-op read.
    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clerkId: CLERK_ID }, update: {} }),
    );
  });

  it('falls back to the first email when there is no primary', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    getUser.mockResolvedValue(profile({ primaryEmailAddress: null }));
    prisma.user.upsert.mockResolvedValue({});

    await service.upsertFromClerk(CLERK_ID);

    expect(createArg().email).toBe('fallback@example.com');
  });

  it('refuses to store a user with no email at all', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    getUser.mockResolvedValue(profile({ primaryEmailAddress: null, emailAddresses: [] }));

    // The column is NOT NULL and every downstream feature assumes an address,
    // so there is no useful partial user to write.
    await expect(service.upsertFromClerk(CLERK_ID)).rejects.toThrow(/no email address/);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('stores a null name when Clerk has neither first nor last', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    getUser.mockResolvedValue(profile({ firstName: null, lastName: null }));
    prisma.user.upsert.mockResolvedValue({});

    await service.upsertFromClerk(CLERK_ID);

    expect(createArg().name).toBe(null);
  });

  it('stores a null avatarUrl when Clerk returns an empty string', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    getUser.mockResolvedValue(profile({ imageUrl: '' }));
    prisma.user.upsert.mockResolvedValue({});

    await service.upsertFromClerk(CLERK_ID);

    expect(createArg().avatarUrl).toBe(null);
  });
});
