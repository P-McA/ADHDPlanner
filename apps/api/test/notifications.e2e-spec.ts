import { DUE_REMINDER_MAX_PER_SWEEP, type PushToken, STREAK_NUDGE_MIN_DAYS } from '@adhd/shared';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { PUSH_SENDER } from '../src/notifications/notifications.ports.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { deviceGone, FakePushSender, rateLimited } from './fakes/push.fakes.js';

/**
 * Reminders against real Postgres, with the provider faked and nothing else.
 *
 * The property this file exists for is rider 2: **a sweep repeated on the same
 * day must not send the same notification twice.** That cannot be checked by
 * looking at the dispatch table — one row looks the same however many pushes
 * went out — so every idempotency test here counts what reached the *sender*.
 * `FakePushSender.batches` is the only witness that can tell the difference.
 *
 * The streak nudge is the sharp case and is tested hardest: its trigger
 * condition ("they have not finished anything today") stays true all day, so
 * an hourly sweep re-evaluates it to `true` twelve times and only the claim in
 * `notification_dispatches` stops twelve pushes.
 */

interface ExecutionContextLike {
  switchToHttp: () => { getRequest: () => AuthenticatedRequest };
}

let app: INestApplication;
let prisma: PrismaService;
let notifications: NotificationsService;
let userA: string;
let userB: string;

/** The only fake in this suite. Postgres and the dispatch ledger are real. */
const sender = new FakePushSender();

const suffix = Date.now().toString(36);

const http = (): Server => app.getHttpServer() as Server;

const asUser = (userId: string): Record<string, string> => ({ 'x-test-user': userId });

const TOKEN_A = `ExponentPushToken[phone-a-${suffix}]`;
const TOKEN_B = `ExponentPushToken[tablet-b-${suffix}]`;

/**
 * A fixed instant inside the notify window in every timezone used here.
 *
 * 14:00 UTC is early afternoon in London and mid-morning in New York, so both
 * users are awake and neither test is one DST transition away from silently
 * asserting nothing.
 */
const MIDDAY = new Date('2026-09-09T14:00:00.000Z');
const TODAY = '2026-09-09';
const YESTERDAY = '2026-09-08';

const dateColumn = (calendarDate: string): Date => new Date(`${calendarDate}T00:00:00.000Z`);

/** A task due at 5pm London on the sweep's day. */
const dueToday = async (userId: string, title: string, hourUtc = 16): Promise<string> => {
  const task = await prisma.task.create({
    data: {
      userId,
      title,
      dueAt: new Date(`${TODAY}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`),
    },
  });

  return task.id;
};

const giveStreak = async (userId: string, days: number, lastActive: string): Promise<void> => {
  await prisma.streak.upsert({
    where: { userId },
    create: {
      userId,
      currentStreak: days,
      longestStreak: days,
      lastActiveDate: dateColumn(lastActive),
    },
    update: {
      currentStreak: days,
      longestStreak: days,
      lastActiveDate: dateColumn(lastActive),
    },
  });
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ClerkAuthGuard)
    .useValue({
      canActivate: (context: ExecutionContextLike) => {
        const req = context.switchToHttp().getRequest();
        const header = req.headers['x-test-user'];

        if (typeof header !== 'string') return false;

        req.appUser = { id: header, clerkId: `clerk_${header}` };

        return true;
      },
    })
    .overrideProvider(PUSH_SENDER)
    .useValue(sender)
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  await app.listen(0, '127.0.0.1');

  prisma = app.get(PrismaService);
  notifications = app.get(NotificationsService);

  const a = await prisma.user.create({
    data: {
      clerkId: `clerk_notif_a_${suffix}`,
      email: `notif-a-${suffix}@test.local`,
      timezone: 'Europe/London',
    },
  });
  const b = await prisma.user.create({
    data: {
      clerkId: `clerk_notif_b_${suffix}`,
      email: `notif-b-${suffix}@test.local`,
      timezone: 'Europe/London',
    },
  });

  userA = a.id;
  userB = b.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await app.close();
});

beforeEach(async () => {
  sender.reset();
  sender.respondWith = (messages) => messages.map((m) => ({ token: m.token, ok: true }));

  await prisma.notificationDispatch.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.pushToken.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.streak.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.xpEvent.deleteMany({ where: { userId: { in: [userA, userB] } } });
  await prisma.task.deleteMany({ where: { userId: { in: [userA, userB] } } });
});

describe('POST /me/push-tokens — registering a device', () => {
  it('records the device and hands it back', async () => {
    const res = await request(http())
      .post('/me/push-tokens')
      .set(asUser(userA))
      .send({ token: TOKEN_A })
      .expect(200);

    expect((res.body as PushToken).token).toBe(TOKEN_A);
    expect(await prisma.pushToken.count({ where: { userId: userA } })).toBe(1);
  });

  it('is idempotent — an app that registers on every launch keeps one row', async () => {
    // The normal client behaviour, not an edge case: an Expo app asks for its
    // token at start-up and posts whatever it gets.
    for (let i = 0; i < 3; i += 1) {
      await request(http()).post('/me/push-tokens').set(asUser(userA)).send({ token: TOKEN_A });
    }

    expect(await prisma.pushToken.count({ where: { userId: userA } })).toBe(1);
  });

  it('moves a handed-on device to its new owner rather than duplicating it', async () => {
    await request(http()).post('/me/push-tokens').set(asUser(userA)).send({ token: TOKEN_A });
    await request(http())
      .post('/me/push-tokens')
      .set(asUser(userB))
      .send({ token: TOKEN_A })
      .expect(200);

    // The old owner's reminders must stop going to a phone that is now
    // somebody else's, and nothing else in the system would ever notice: the
    // sends would all succeed.
    expect(await prisma.pushToken.count({ where: { userId: userA } })).toBe(0);
    expect(await prisma.pushToken.count({ where: { userId: userB } })).toBe(1);
  });

  it('refuses a token that could never work, with 400', async () => {
    await request(http())
      .post('/me/push-tokens')
      .set(asUser(userA))
      .send({ token: 'not-a-push-token' })
      .expect(400);

    expect(await prisma.pushToken.count({ where: { userId: userA } })).toBe(0);
  });

  it('lists only the caller’s devices', async () => {
    await request(http()).post('/me/push-tokens').set(asUser(userA)).send({ token: TOKEN_A });
    await request(http()).post('/me/push-tokens').set(asUser(userB)).send({ token: TOKEN_B });

    const res = await request(http()).get('/me/push-tokens').set(asUser(userA)).expect(200);

    expect((res.body as PushToken[]).map((row) => row.token)).toEqual([TOKEN_A]);
  });

  it('deregisters a device, and says nothing about one that is not the caller’s', async () => {
    await request(http()).post('/me/push-tokens').set(asUser(userB)).send({ token: TOKEN_B });

    // Someone else's token: 204, and B's row survives. A 404 here would confirm
    // the token exists, which is the leak 404-not-403 exists to close.
    await request(http())
      .delete('/me/push-tokens')
      .set(asUser(userA))
      .send({ token: TOKEN_B })
      .expect(204);

    expect(await prisma.pushToken.count({ where: { userId: userB } })).toBe(1);

    await request(http())
      .delete('/me/push-tokens')
      .set(asUser(userB))
      .send({ token: TOKEN_B })
      .expect(204);

    expect(await prisma.pushToken.count({ where: { userId: userB } })).toBe(0);
  });
});

describe('The sweep — due reminders', () => {
  beforeEach(async () => {
    await prisma.pushToken.create({ data: { userId: userA, token: TOKEN_A } });
  });

  it('reminds the user about a task due today that is not finished', async () => {
    const taskId = await dueToday(userA, 'Book the car in');

    await notifications.runSweep(MIDDAY);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.token).toBe(TOKEN_A);
    expect(sender.sent[0]?.body).toBe('Book the car in');
    expect(sender.sent[0]?.data).toMatchObject({ kind: 'due_reminder', taskId });

    const dispatch = await prisma.notificationDispatch.findFirst({ where: { userId: userA } });
    expect(dispatch?.status).toBe('sent');
    expect(dispatch?.deliveredCount).toBe(1);
    expect(dispatch?.dedupeKey).toBe(`due_reminder:${TODAY}:${taskId}`);
  });

  it('does not send twice when the same day is swept again', async () => {
    await dueToday(userA, 'Book the car in');

    await notifications.runSweep(MIDDAY);
    await notifications.runSweep(new Date('2026-09-09T15:00:00.000Z'));
    await notifications.runSweep(new Date('2026-09-09T16:00:00.000Z'));

    // The ledger cannot show this — one row looks the same after one push or
    // three. Only the sender knows.
    expect(sender.sent).toHaveLength(1);
    expect(await prisma.notificationDispatch.count({ where: { userId: userA } })).toBe(1);
  });

  it('says nothing about a task that is already done', async () => {
    const taskId = await dueToday(userA, 'Already finished');
    await prisma.task.update({
      where: { id: taskId },
      data: { status: 'done', completedAt: new Date() },
    });

    await notifications.runSweep(MIDDAY);

    expect(sender.sent).toHaveLength(0);
  });

  it('says nothing about a task due on another day', async () => {
    await prisma.task.create({
      data: { userId: userA, title: 'Tomorrow', dueAt: new Date('2026-09-10T16:00:00.000Z') },
    });

    await notifications.runSweep(MIDDAY);

    expect(sender.sent).toHaveLength(0);
  });

  it('never mentions an unconfirmed AI draft — the fence holds here too', async () => {
    await prisma.task.create({
      data: {
        userId: userA,
        title: 'Something the AI thought it heard',
        dueAt: new Date(`${TODAY}T16:00:00.000Z`),
        source: 'ai_suggested',
        confirmedAt: null,
      },
    });

    await notifications.runSweep(MIDDAY);

    // A push about a task the user has never agreed to would be the app
    // auto-creating work by the back door — the one thing CLAUDE.md calls
    // non-negotiable.
    expect(sender.sent).toHaveLength(0);
    expect(await prisma.notificationDispatch.count({ where: { userId: userA } })).toBe(0);
  });

  it('does mention a suggestion once the user has approved it', async () => {
    await prisma.task.create({
      data: {
        userId: userA,
        title: 'Book the car in',
        dueAt: new Date(`${TODAY}T16:00:00.000Z`),
        source: 'ai_suggested',
        confirmedAt: new Date(),
      },
    });

    await notifications.runSweep(MIDDAY);

    // The predicate is the pair, not `source` alone: an approved suggestion is
    // the user's task and keeps its provenance for ever.
    expect(sender.sent).toHaveLength(1);
  });

  it('reaches every device the user has registered', async () => {
    await prisma.pushToken.create({ data: { userId: userA, token: TOKEN_B } });
    await dueToday(userA, 'Book the car in');

    await notifications.runSweep(MIDDAY);

    expect(sender.sent.map((m) => m.token).sort()).toEqual([TOKEN_A, TOKEN_B].sort());

    const dispatch = await prisma.notificationDispatch.findFirst({ where: { userId: userA } });
    expect(dispatch?.deliveredCount).toBe(2);
  });

  it('sends at most a handful at once, and picks the rest up next time', async () => {
    const wanted = DUE_REMINDER_MAX_PER_SWEEP + 2;

    for (let i = 0; i < wanted; i += 1) {
      await dueToday(userA, `Task ${String(i)}`, 8 + i);
    }

    await notifications.runSweep(MIDDAY);
    expect(sender.sent).toHaveLength(DUE_REMINDER_MAX_PER_SWEEP);

    await notifications.runSweep(new Date('2026-09-09T15:00:00.000Z'));

    // The overflow is not dropped; it rolls forward. And the ones already sent
    // do not come back round.
    expect(sender.sent).toHaveLength(wanted);
    expect(new Set(sender.sent.map((m) => m.body)).size).toBe(wanted);
  });

  it('leaves other users alone', async () => {
    await prisma.pushToken.create({ data: { userId: userB, token: TOKEN_B } });
    await dueToday(userA, 'A only');

    await notifications.runSweep(MIDDAY);

    expect(sender.sentTo(TOKEN_B)).toHaveLength(0);
  });
});

describe('The sweep — streak nudge', () => {
  beforeEach(async () => {
    await prisma.pushToken.create({ data: { userId: userA, token: TOKEN_A } });
  });

  it('nudges a run worth protecting that would break today', async () => {
    await giveStreak(userA, STREAK_NUDGE_MIN_DAYS, YESTERDAY);

    await notifications.runSweep(MIDDAY);

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.data).toMatchObject({ kind: 'streak_nudge' });
    expect(sender.sent[0]?.title).toContain(String(STREAK_NUDGE_MIN_DAYS));

    const dispatch = await prisma.notificationDispatch.findFirst({
      where: { userId: userA, kind: 'streak_nudge' },
    });
    expect(dispatch?.dedupeKey).toBe(`streak_nudge:${TODAY}`);
    expect(dispatch?.status).toBe('sent');
  });

  it('nudges once a day however many times the day is swept', async () => {
    await giveStreak(userA, 7, YESTERDAY);

    // The point of the whole dispatch table. "They have not finished anything
    // today" is still true at 15:00, and at 16:00, and at 17:00 — the trigger
    // condition does not consume itself the way a due-date does, so without a
    // claim the user gets nudged every hour until midnight.
    for (const hour of ['14', '15', '16', '17', '18', '19', '20']) {
      await notifications.runSweep(new Date(`${TODAY}T${hour}:00:00.000Z`));
    }

    expect(sender.sent).toHaveLength(1);
    expect(await prisma.notificationDispatch.count({ where: { userId: userA } })).toBe(1);
  });

  it('stays quiet below the threshold, where there is nothing worth protecting', async () => {
    await giveStreak(userA, STREAK_NUDGE_MIN_DAYS - 1, YESTERDAY);

    await notifications.runSweep(MIDDAY);

    expect(sender.sent).toHaveLength(0);
  });

  it('stays quiet once they have finished something today', async () => {
    await giveStreak(userA, 7, TODAY);

    await notifications.runSweep(MIDDAY);

    expect(sender.sent).toHaveLength(0);
  });

  it('does not nudge about a run that is already broken', async () => {
    // currentStreak is not recomputed until the next completion, so a run last
    // touched five days ago still reads as 12. Nudging on it would tell the
    // user they are about to lose something they lost last week.
    await giveStreak(userA, 12, '2026-09-04');

    await notifications.runSweep(MIDDAY);

    expect(sender.sent).toHaveLength(0);
  });

  it('nudges again the following day, because that is a different day', async () => {
    await giveStreak(userA, 7, YESTERDAY);
    await notifications.runSweep(MIDDAY);

    // Still nothing finished; the run is now 7 days old and last active on the
    // 9th, which is the day before the 10th.
    await giveStreak(userA, 7, TODAY);
    await notifications.runSweep(new Date('2026-09-10T14:00:00.000Z'));

    expect(sender.sent).toHaveLength(2);
    expect(await prisma.notificationDispatch.count({ where: { userId: userA } })).toBe(2);
  });
});

describe('The sweep — when the provider says no', () => {
  beforeEach(async () => {
    await prisma.pushToken.create({ data: { userId: userA, token: TOKEN_A } });
  });

  it('deletes a registration the provider says is gone for good', async () => {
    sender.respondWith = deviceGone;
    await dueToday(userA, 'Book the car in');

    await notifications.runSweep(MIDDAY);

    expect(await prisma.pushToken.count({ where: { userId: userA } })).toBe(0);

    const dispatch = await prisma.notificationDispatch.findFirst({ where: { userId: userA } });
    expect(dispatch?.status).toBe('failed');
    expect(dispatch?.deliveredCount).toBe(0);
    expect(dispatch?.error).toContain('device_not_registered');
  });

  it('keeps a perfectly good registration through a transient failure', async () => {
    sender.respondWith = rateLimited;
    await dueToday(userA, 'Book the car in');

    await notifications.runSweep(MIDDAY);

    // Deleting here would silently unsubscribe someone who did nothing wrong,
    // and they would not find out until they next opened the app — if ever.
    expect(await prisma.pushToken.count({ where: { userId: userA } })).toBe(1);
    expect(
      (await prisma.notificationDispatch.findFirst({ where: { userId: userA } }))?.status,
    ).toBe('failed');
  });

  it('deletes only the device that is gone, not the one beside it', async () => {
    await prisma.pushToken.create({ data: { userId: userA, token: TOKEN_B } });
    await dueToday(userA, 'Book the car in');

    sender.respondWith = (messages) =>
      messages.map((message) =>
        message.token === TOKEN_A
          ? { token: message.token, ok: false, reason: 'device_not_registered' as const }
          : { token: message.token, ok: true },
      );

    await notifications.runSweep(MIDDAY);

    // This is what PushReceipt.token is for. Correlating by position instead
    // would be one off-by-one from unsubscribing the wrong device.
    const left = await prisma.pushToken.findMany({ where: { userId: userA } });
    expect(left.map((row) => row.token)).toEqual([TOKEN_B]);

    // One device reached out of two is still a delivered notification.
    const dispatch = await prisma.notificationDispatch.findFirst({ where: { userId: userA } });
    expect(dispatch?.status).toBe('sent');
    expect(dispatch?.deliveredCount).toBe(1);
  });

  it('does not retry a failed send later the same day, and the row says why', async () => {
    sender.respondWith = rateLimited;
    await dueToday(userA, 'Book the car in');

    await notifications.runSweep(MIDDAY);
    sender.respondWith = (messages) => messages.map((m) => ({ token: m.token, ok: true }));
    await notifications.runSweep(new Date('2026-09-09T15:00:00.000Z'));

    // The stated cost of claiming before sending: a provider outage loses that
    // reminder for the day rather than retrying it. It is lost *visibly* — the
    // row carries `failed` and the provider's own words — which is the half of
    // the trade that makes it acceptable.
    expect(sender.sent).toHaveLength(1);
    expect(
      (await prisma.notificationDispatch.findFirst({ where: { userId: userA } }))?.error,
    ).toContain('message_rate_exceeded');
  });

  it('survives a sender that breaks its contract and throws', async () => {
    sender.respondWith = () => {
      throw new Error('provider adapter is broken');
    };
    await dueToday(userA, 'Book the car in');

    // A dead push channel must never take out the sweep, still less the API it
    // runs inside.
    await expect(notifications.runSweep(MIDDAY)).resolves.toBeDefined();

    const dispatch = await prisma.notificationDispatch.findFirst({ where: { userId: userA } });
    // Not left on `claimed` — the status that means "in flight", attached to
    // something that will never land.
    expect(dispatch?.status).toBe('failed');
  });
});

describe('The sweep — who it will not wake up', () => {
  it('sends nothing to a user with no registered device', async () => {
    await dueToday(userA, 'Book the car in');

    const summary = await notifications.runSweep(MIDDAY);

    expect(sender.sent).toHaveLength(0);
    // And crucially claims nothing: registering a phone at lunchtime must not
    // find the day's reminder already spent.
    expect(await prisma.notificationDispatch.count({ where: { userId: userA } })).toBe(0);
    expect(summary.usersConsidered).toBe(0);
  });

  it('registers late and still gets the reminder the same day', async () => {
    await dueToday(userA, 'Book the car in');
    await notifications.runSweep(MIDDAY);

    await prisma.pushToken.create({ data: { userId: userA, token: TOKEN_A } });
    await notifications.runSweep(new Date('2026-09-09T15:00:00.000Z'));

    expect(sender.sent).toHaveLength(1);
  });

  it('does not push at three in the morning', async () => {
    await prisma.pushToken.create({ data: { userId: userA, token: TOKEN_A } });
    await dueToday(userA, 'Book the car in');

    // 02:00 UTC is 03:00 in London. An hourly sweep with no window would
    // deliver every reminder at the first run of the user's new day.
    await notifications.runSweep(new Date(`${TODAY}T02:00:00.000Z`));

    expect(sender.sent).toHaveLength(0);
    expect(await prisma.notificationDispatch.count({ where: { userId: userA } })).toBe(0);
  });

  it('reads the window on the user’s clock, not the server’s', async () => {
    await prisma.user.update({ where: { id: userA }, data: { timezone: 'Pacific/Auckland' } });
    await prisma.pushToken.create({ data: { userId: userA, token: TOKEN_A } });
    await dueToday(userA, 'Book the car in');

    // 14:00 UTC is inside the window in London and the middle of the night in
    // Auckland. If server time ever leaked back in, this passes and the user
    // gets woken up.
    await notifications.runSweep(MIDDAY);

    expect(sender.sent).toHaveLength(0);

    await prisma.user.update({ where: { id: userA }, data: { timezone: 'Europe/London' } });
  });
});
