import type { RankedTaskPage, User } from '@adhd/shared';
import { type ExecutionContext, type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import type { AuthenticatedRequest } from '../src/auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../src/auth/clerk-auth.guard.js';
import { localCalendarDate, localDayBoundsUtc } from '../src/common/calendar.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * `PATCH /me`, end to end: the phone reports the zone it is in, and "today"
 * on the server follows.
 *
 * Until this route existed nothing ever wrote `users.timezone`, so every real
 * account sat on the UTC default while the phone stamped "due today" on its own
 * clock — and the two disagreed about which day a task was due for anyone not
 * on UTC.
 */
describe('Profile time zone (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userA: string;
  let userB: string;

  const suffix = Date.now().toString(36);
  const http = (): Server => app.getHttpServer() as Server;
  const json = <T>(res: Response): T => res.body as T;
  const asUser = (userId: string): Record<string, string> => ({ 'x-test-user': userId });
  const patchMe = (userId: string, body: Record<string, unknown>) =>
    request(http()).patch('/me').set(asUser(userId)).send(body);
  const zoneOf = async (userId: string): Promise<string> =>
    (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).timezone;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(ClerkAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext): boolean => {
          const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
          const id = req.headers['x-test-user'];

          if (typeof id !== 'string') return false;

          req.appUser = { id, clerkId: `clerk_${id}` };

          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0, '127.0.0.1');

    prisma = app.get(PrismaService);

    const [a, b] = await Promise.all([
      prisma.user.create({
        data: { clerkId: `clerk_tz_a_${suffix}`, email: `tz_a_${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { clerkId: `clerk_tz_b_${suffix}`, email: `tz_b_${suffix}@test.local` },
      }),
    ]);
    userA = a.id;
    userB = b.id;
  });

  afterAll(async () => {
    await prisma.task.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await app.close();
  });

  beforeEach(async () => {
    await prisma.task.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.user.updateMany({
      where: { id: { in: [userA, userB] } },
      data: { timezone: 'UTC' },
    });
  });

  it('stores the zone the phone reports, and /me reads it back', async () => {
    const res = await patchMe(userA, { timezone: 'Europe/London' }).expect(200);

    expect(json<User>(res).timezone).toBe('Europe/London');
    expect(await zoneOf(userA)).toBe('Europe/London');

    const me = await request(http()).get('/me').set(asUser(userA)).expect(200);
    expect(json<User>(me).timezone).toBe('Europe/London');
  });

  it('changes only the caller’s profile', async () => {
    await patchMe(userA, { timezone: 'Pacific/Auckland' }).expect(200);

    expect(await zoneOf(userB)).toBe('UTC');
  });

  it.each(['Mars/Olympus_Mons', '+01:00', ''])(
    'refuses %j with 400 and leaves the profile alone',
    async (timezone) => {
      await patchMe(userA, { timezone }).expect(400);

      expect(await zoneOf(userA)).toBe('UTC');
    },
  );

  it('refuses any other profile field rather than silently ignoring it', async () => {
    await patchMe(userA, { timezone: 'Europe/London', email: 'someone@else.test' }).expect(400);

    expect(await zoneOf(userA)).toBe('UTC');
  });

  it('decides "Due today" on the reported zone', async () => {
    // A zone far from UTC, and a task due in the last minute of *its* today.
    // On the UTC default that instant may fall on another calendar day; once
    // the zone is reported, Next up must call it today.
    const zone = 'Pacific/Kiritimati';
    const today = localCalendarDate(new Date(), zone);
    const lastMinute = new Date(localDayBoundsUtc(today, zone).end.getTime() - 60_000);

    await request(http())
      .post('/tasks')
      .set(asUser(userA))
      .send({ title: 'Due tonight, local', dueAt: lastMinute.toISOString() })
      .expect(201);
    await patchMe(userA, { timezone: zone }).expect(200);

    const res = await request(http()).get('/tasks/next').set(asUser(userA)).expect(200);

    expect(json<RankedTaskPage>(res).items[0]!.rank.reasons).toContain('Due today');
  });
});
