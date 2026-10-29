/**
 * Demo data for a rehearsal or a recorded fallback.
 *
 * Creates one `dev_demo` user (the dev-bypass label) with two weeks of
 * history, a live streak, badges, and a handful of open tasks. The history is
 * what makes "Suggest tasks" and the weekly digest show something; a fresh
 * account always says "Nothing to suggest yet".
 *
 * Run with the compose services up:
 *   pnpm --filter @adhd/api db:seed:demo
 *
 * It deletes and recreates only `dev_demo`, so it is safe to run repeatedly.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

try {
  process.loadEnvFile();
} catch {
  // Ambient environment is fine.
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set — see apps/api/.env.example');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const DAY = 86_400_000;
const now = Date.now();
const at = (daysAgo, hour = 10) => new Date(now - daysAgo * DAY + hour * 3_600_000);

/** Finished work, in the order it was done. Pairs share words on purpose. */
const HISTORY = [
  ['Book the MOT', 13],
  ['Ring the garage about the MOT', 12],
  ['Pay the electricity bill', 12],
  ['Take the bins out', 11],
  ['Order the repeat prescription', 10],
  ['Ring the dentist about a check-up', 10],
  ['Book the dentist check-up', 9],
  ['Send the signed contract back', 8],
  ['Print the contract', 8],
  ['Buy dog food', 7],
  ['Take the bins out', 6],
  ['Pay the water bill', 5],
  ['Ring the plumber about the leak', 5],
  ['Book the plumber', 4],
  ['Renew the car insurance', 3],
  ['Take the bins out', 2],
  ['Send the invoice', 1],
  ['Ring the garage about the service', 1],
];

const OPEN = [
  ['Book the car service', 0, 'high'],
  ['Pay the council tax', 0, 'urgent'],
  ['Ring the optician', 1, 'med'],
  ['Buy a birthday card', 3, 'low'],
  ['Sort the paperwork on the desk', null, 'med'],
];

async function main() {
  const existing = await prisma.user.findUnique({ where: { clerkId: 'dev_demo' } });

  if (existing) {
    await prisma.user.delete({ where: { id: existing.id } });
  }

  const user = await prisma.user.create({
    data: {
      clerkId: 'dev_demo',
      email: 'demo@dev.local',
      name: 'Demo',
      timezone: 'Europe/London',
      onboardedAt: new Date(),
    },
  });

  for (const [title, daysAgo] of HISTORY) {
    const completedAt = at(daysAgo, 9 + (daysAgo % 8));

    const task = await prisma.task.create({
      data: {
        userId: user.id,
        title,
        status: 'done',
        source: 'manual',
        completedAt,
        confirmedAt: completedAt,
      },
    });

    await prisma.xpEvent.create({
      data: {
        userId: user.id,
        taskId: task.id,
        type: 'task_complete',
        xpAmount: 10,
        awardKey: `task_complete:${task.id}:${completedAt.toISOString().slice(0, 10)}`,
      },
    });
  }

  for (const [title, dueInDays, manualPriority] of OPEN) {
    await prisma.task.create({
      data: {
        userId: user.id,
        title,
        manualPriority,
        dueAt: dueInDays === null ? null : at(-dueInDays, 17),
      },
    });
  }

  await prisma.streak.create({
    data: {
      userId: user.id,
      currentStreak: 9,
      longestStreak: 12,
      freezes: 1,
      lastActiveDate: new Date(new Date().toISOString().slice(0, 10)),
    },
  });

  await prisma.userBadge.createMany({
    data: [
      { userId: user.id, badgeKey: 'first_task_done' },
      { userId: user.id, badgeKey: 'streak_3' },
    ],
    skipDuplicates: true,
  });

  console.log(`Seeded dev_demo (${user.id}): ${HISTORY.length} done, ${OPEN.length} open.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
