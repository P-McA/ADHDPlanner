import { type DependencyHealth, type HealthResponse } from '@adhd/shared';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { StorageService } from '../storage/storage.service.js';

/** Runs a probe and reports outcome plus latency, never throwing. */
async function probe(run: () => Promise<unknown>): Promise<DependencyHealth> {
  const startedAt = Date.now();
  try {
    await run();
    return { status: 'ok', latencyMs: Date.now() - startedAt, error: null };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    // Probed concurrently so total latency is the slower dependency, not the sum.
    const [postgres, redis, storage] = await Promise.all([
      probe(() => this.prisma.ping()),
      probe(() => this.redis.ping()),
      probe(() => this.storage.ping()),
    ]);

    const healthy =
      postgres.status === 'ok' && redis.status === 'ok' && storage.status === 'ok';
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: healthy ? 'ok' : 'error',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      dependencies: { postgres, redis, storage },
    };
  }
}
