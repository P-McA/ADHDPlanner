import 'reflect-metadata';

import { clerkMiddleware } from '@clerk/express';
import { Logger, ValidationPipe } from '@nestjs/common';
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

  // Verifies the Clerk session and populates req.auth. Registered before the
  // guards run so ClerkAuthGuard has something to read; it does not itself
  // reject anonymous requests, which is what keeps /health public.
  app.use(clerkMiddleware());

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties, then reject rather than ignore them: sending
      // `source` to PATCH /tasks/:id must fail loudly, not silently no-op.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Query and path params arrive as strings; without this the @Type
      // conversions in the DTOs never run.
      transform: true,
    }),
  );

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);

  Logger.log(`API listening on http://localhost:${String(port)}`, 'Bootstrap');
}

void bootstrap();
