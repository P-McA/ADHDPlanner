import { PrismaPg } from '@prisma/adapter-pg';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Owns the Prisma connection lifecycle so Nest tears the pool down with the
 * app rather than leaving it dangling on shutdown.
 *
 * Prisma 7 connects through a driver adapter rather than a built-in engine, so
 * the pg pool is constructed here from DATABASE_URL.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — see apps/api/.env.example');
    }
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheapest round-trip that proves the connection is live. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
