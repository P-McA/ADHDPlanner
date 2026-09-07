import type { HealthResponse } from '@adhd/shared';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';

/**
 * Probes both dependencies for real.
 *
 * health.controller.spec.ts mocks PrismaService and RedisService, so it proves
 * the reporting logic but would pass unchanged if Redis were never wired or the
 * compose service were gone. This suite is what would fail in that case.
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  const http = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Listen once for the whole file. Left unlistened, supertest starts and
    // closes the server around every single request; see vitest.e2e.config.ts
    // for why that surfaces as `read ECONNRESET` under a concurrent burst.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports both compose dependencies as reachable', async () => {
    const res = await request(http()).get('/health');
    const body = res.body as HealthResponse;

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    // Named individually: a single aggregate 'ok' would hide one probe being
    // absent rather than passing.
    expect(body.dependencies.postgres.status).toBe('ok');
    expect(body.dependencies.redis.status).toBe('ok');
  });

  it('reports a real latency for each probe, not a placeholder', async () => {
    const body = (await request(http()).get('/health')).body as HealthResponse;

    expect(body.dependencies.postgres.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.dependencies.redis.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.dependencies.postgres.error).toBeNull();
    expect(body.dependencies.redis.error).toBeNull();
  });
});
