import { HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { HealthController } from './health.controller.js';

/** Minimal passthrough Response double — the controller only sets a status. */
function createResponse(): Response & { statusCode: number } {
  const res = {
    statusCode: HttpStatus.OK,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number };
}

describe('HealthController', () => {
  let controller: HealthController;
  let prismaPing: ReturnType<typeof vi.fn>;
  let redisPing: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    prismaPing = vi.fn().mockResolvedValue(undefined);
    redisPing = vi.fn().mockResolvedValue(undefined);

    // Goes through the real Nest DI container on purpose: this is what proves
    // decorator metadata survives the Vitest transform (see vitest.config.ts).
    // The backing services are stubbed so the suite needs no live PG or Redis.
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    })
      .useMocker((token) => {
        if (token === PrismaService) return { ping: prismaPing };
        if (token === RedisService) return { ping: redisPing };
        return undefined;
      })
      .compile();

    controller = moduleRef.get(HealthController);
  });

  it('resolves from the DI container', () => {
    expect(controller).toBeInstanceOf(HealthController);
  });

  it('reports ok with a non-negative uptime when both dependencies answer', async () => {
    const res = createResponse();
    const result = await controller.check(res);

    expect(result.status).toBe('ok');
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(res.statusCode).toBe(HttpStatus.OK);
  });

  it('reports an ISO 8601 timestamp', async () => {
    const { timestamp } = await controller.check(createResponse());

    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });

  it('reports each dependency individually', async () => {
    const { dependencies } = await controller.check(createResponse());

    expect(dependencies.postgres.status).toBe('ok');
    expect(dependencies.redis.status).toBe('ok');
    expect(dependencies.postgres.error).toBeNull();
    expect(dependencies.postgres.latencyMs).toBeGreaterThanOrEqual(0);
    expect(prismaPing).toHaveBeenCalledOnce();
    expect(redisPing).toHaveBeenCalledOnce();
  });

  it('degrades to 503 and names the failing dependency when Postgres is down', async () => {
    prismaPing.mockRejectedValue(new Error('connection refused'));
    const res = createResponse();

    const result = await controller.check(res);

    expect(result.status).toBe('error');
    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(result.dependencies.postgres.status).toBe('error');
    expect(result.dependencies.postgres.error).toBe('connection refused');
    // The healthy dependency is still reported as healthy.
    expect(result.dependencies.redis.status).toBe('ok');
  });

  it('degrades to 503 when Redis is down', async () => {
    redisPing.mockRejectedValue(new Error('READONLY'));
    const res = createResponse();

    const result = await controller.check(res);

    expect(result.status).toBe('error');
    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(result.dependencies.redis.error).toBe('READONLY');
  });
});
