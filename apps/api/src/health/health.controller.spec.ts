import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    // Goes through the real Nest DI container on purpose: this is what proves
    // decorator metadata survives the Vitest transform (see vitest.config.ts).
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('resolves from the DI container', () => {
    expect(controller).toBeInstanceOf(HealthController);
  });

  it('reports ok with a non-negative uptime', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports an ISO 8601 timestamp', () => {
    const { timestamp } = controller.check();

    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });
});
