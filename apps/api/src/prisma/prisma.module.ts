import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';

/**
 * Global so feature modules can inject PrismaService without each one
 * re-importing it — and, more importantly, so there is exactly one connection
 * pool for the process rather than one per importing module.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
