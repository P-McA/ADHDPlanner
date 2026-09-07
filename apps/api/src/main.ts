import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

// Local dev reads DATABASE_URL/REDIS_URL from apps/api/.env. Deployed
// environments inject real env vars and ship no .env file, so a miss is fine.
// Must run before AppModule is instantiated, since providers read env at construction.
try {
  process.loadEnvFile();
} catch {
  // No .env present — rely on the ambient environment.
}

const DEFAULT_PORT = 3001;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);

  Logger.log(`API listening on http://localhost:${String(port)}`, 'Bootstrap');
}

void bootstrap();
