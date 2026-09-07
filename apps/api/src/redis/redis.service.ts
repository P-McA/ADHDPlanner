import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/**
 * Wraps the ioredis connection.
 *
 * `lazyConnect` keeps construction side-effect free so the app boots even when
 * Redis is down — the health probe is then what reports it, rather than the
 * process dying at startup. Retries are capped for the same reason: an
 * unreachable Redis should surface as an unhealthy dependency, not an
 * indefinite reconnect storm.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    this.client = new Redis(process.env.REDIS_URL ?? DEFAULT_REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 100, 1000)),
    });

    // Without a listener, ioredis emits unhandled 'error' events that crash the
    // process while Redis is unavailable.
    this.client.on('error', () => undefined);
  }

  onModuleDestroy(): void {
    // disconnect() is synchronous in ioredis; nothing to await.
    this.client.disconnect();
  }

  /** Round-trips PING, connecting on first use. */
  async ping(): Promise<void> {
    if (this.client.status === 'end' || this.client.status === 'wait') {
      await this.client.connect();
    }
    // Widened to string: ping() is typed as the literal 'PONG', which would
    // narrow to never in the guard below and break the error message.
    const reply: string = await this.client.ping();
    if (reply !== 'PONG') {
      throw new Error(`unexpected PING reply: ${reply}`);
    }
  }
}
