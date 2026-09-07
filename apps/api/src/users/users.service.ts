import { clerkClient } from '@clerk/express';
import { Injectable, Logger } from '@nestjs/common';
import type { User as PrismaUser } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Owns the projection of a Clerk identity into the `users` table.
 *
 * Clerk remains the source of truth for identity; this table exists so tasks
 * have a stable local foreign key and so profile fields (timezone) have
 * somewhere to live.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the user for a Clerk subject, creating it on first sight.
   *
   * The read comes first because it is the overwhelmingly common path — only
   * the very first request for a subject pays for the Clerk API round-trip.
   */
  async upsertFromClerk(clerkId: string): Promise<PrismaUser> {
    const existing = await this.prisma.user.findUnique({ where: { clerkId } });
    if (existing) {
      return existing;
    }

    const profile = await clerkClient.users.getUser(clerkId);
    const email =
      profile.primaryEmailAddress?.emailAddress ?? profile.emailAddresses[0]?.emailAddress;

    if (!email) {
      // Every downstream feature (reminders, digests) assumes an address, and
      // the column is NOT NULL, so there is no useful partial user to store.
      throw new Error(`Clerk user ${clerkId} has no email address`);
    }

    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || null;

    this.logger.log(`Provisioning local user for Clerk subject ${clerkId}`);

    // upsert, not create: two concurrent first requests would otherwise race
    // and one would fail the unique constraint on clerk_id.
    return this.prisma.user.upsert({
      where: { clerkId },
      create: { clerkId, email, name, avatarUrl: profile.imageUrl || null },
      update: {},
    });
  }

  /**
   * Local user for a development label, with no Clerk involvement at all.
   *
   * Exists so the web client can be driven without Clerk keys. It cannot reuse
   * {@link upsertFromClerk}: that calls Clerk's API for any subject it has not
   * seen, which fails outright with placeholder keys.
   *
   * The `dev_` prefix keeps these rows from ever colliding with a real Clerk
   * subject id, so a development user can never be mistaken for a real one.
   * Guarding *whether* this may be called is ClerkAuthGuard's job, not this
   * method's — see the dev-bypass conditions there.
   */
  async provisionDevUser(label: string): Promise<PrismaUser> {
    const clerkId = `dev_${label}`;

    return this.prisma.user.upsert({
      where: { clerkId },
      create: { clerkId, email: `${label}@dev.local`, name: label },
      update: {},
    });
  }
}
