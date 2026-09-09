import type { PushToken } from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import type { PushReceipt } from './notifications.ports.js';

@Injectable()
export class PushTokensService {
  private readonly logger = new Logger(PushTokensService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a device as a destination for this user's reminders.
   *
   * An upsert on the **token**, not on `(userId, token)`, because the token is
   * globally unique in the schema: a phone that is wiped and handed to someone
   * else keeps its Expo token, and the second person's registration must *move*
   * it rather than sit alongside the first. The alternative leaves the previous
   * owner's reminders going to a stranger's lock screen, and nothing in the
   * system would ever notice — the sends would all succeed.
   *
   * Idempotent by construction: an app that registers on every cold start, which
   * is the normal thing for an app to do, produces one row.
   */
  async register(userId: string, token: string): Promise<PushToken> {
    const row = await this.prisma.pushToken.upsert({
      where: { token },
      create: { userId, token },
      update: { userId },
    });

    return toPushToken(row);
  }

  /** Every device registered to this user. */
  async list(userId: string): Promise<PushToken[]> {
    const rows = await this.prisma.pushToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(toPushToken);
  }

  /**
   * Removes a device at the user's request — signing out, or turning
   * notifications off.
   *
   * Scoped to the caller, and silent when nothing matched. There is no useful
   * difference to report between "already gone" and "never yours": both mean
   * this user is not going to receive anything on that device, which is what
   * was asked for. Returning 404 for someone else's token would also confirm
   * the token exists, which is the same leak `404-not-403` exists to close.
   */
  async deregister(userId: string, token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({ where: { userId, token } });
  }

  /**
   * Deletes registrations the provider says are gone for good.
   *
   * **Only `device_not_registered`.** Every other failure reason describes a
   * bad moment, not a dead device: deleting on a rate limit or a transport
   * error would silently unsubscribe a blameless user, and — because
   * registration happens on the phone, at app start — they would not find out
   * until they next opened the app, if ever. A missed reminder is recoverable
   * tomorrow; a deleted registration is not recoverable at all from this side.
   *
   * Scoped to the user the sweep was sending for, which closes a real race: if
   * the device was handed on and re-registered to somebody else between the
   * token read and the send, the receipt is about the old owner and deleting by
   * token alone would take the new owner's fresh registration with it.
   */
  async pruneDeadTokens(userId: string, receipts: PushReceipt[]): Promise<number> {
    const dead = receipts
      .filter((receipt) => !receipt.ok && receipt.reason === 'device_not_registered')
      .map((receipt) => receipt.token);

    if (dead.length === 0) {
      return 0;
    }

    const { count } = await this.prisma.pushToken.deleteMany({
      where: { userId, token: { in: dead } },
    });

    if (count > 0) {
      this.logger.log(`Removed ${String(count)} dead push token(s) for user ${userId}`);
    }

    return count;
  }
}

function toPushToken(row: {
  id: string;
  token: string;
  createdAt: Date;
  updatedAt: Date;
}): PushToken {
  return {
    id: row.id,
    token: row.token,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
