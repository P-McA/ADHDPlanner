import 'reflect-metadata';

import { clerkMiddleware } from '@clerk/express';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { devBypassArmed } from './auth/clerk-auth.guard.js';

// Local dev reads DATABASE_URL/REDIS_URL from apps/api/.env. Deployed
// environments inject real env vars and ship no .env file, so a miss is fine.
// Must run before AppModule is instantiated, since providers read env at construction.
try {
  process.loadEnvFile();
} catch {
  // No .env present — rely on the ambient environment.
}

const DEFAULT_PORT = 3001;

/**
 * Whether CLERK_PUBLISHABLE_KEY is shaped like a real key.
 *
 * A shape check, not a validity check — it exists to tell a genuine key from
 * an absent one or from the `pk_test_...` placeholder in .env.example, so a
 * developer who has never configured Clerk gets a working server instead of a
 * 500 on every route. Clerk still does the real parsing and verification.
 */
function clerkKeyLooksUsable(): boolean {
  return /^pk_(test|live)_[\w+/=-]+$/.test(process.env.CLERK_PUBLISHABLE_KEY ?? '');
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  // The web client runs on its own origin (3000) and the API on 3001, so a
  // browser will not send anything without this. Explicit allow-list, never a
  // wildcard: these routes are credentialed, and `*` cannot be combined with
  // credentials anyway. Production must name its origins via CORS_ORIGINS —
  // defaulting to the dev origin there would be a quiet way to trust localhost
  // on a real deployment.
  const corsOrigins = (
    process.env.CORS_ORIGINS?.split(',') ??
    (process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000'])
  )
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (corsOrigins.length > 0) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  }

  // Verifies the Clerk session and populates req.auth. Registered before the
  // guards run so ClerkAuthGuard has something to read; it does not itself
  // reject anonymous requests, which is what keeps /health public.
  //
  // It is skipped in exactly one case: a development server running the auth
  // bypass with no usable publishable key. Clerk throws on *every* request when
  // the key is missing or a placeholder — GET /health included, before any
  // route or guard runs — so mounting it there would 500 the whole API rather
  // than leave the dev header a way in. With real keys present it is always
  // mounted, bypass or not, so the genuine Clerk path is never bypassed by
  // this.
  if (clerkKeyLooksUsable() || !devBypassArmed()) {
    app.use(clerkMiddleware());
  } else {
    Logger.warn(
      'No usable CLERK_PUBLISHABLE_KEY: Clerk is not mounted and only DEV_AUTH_BYPASS sign-in will work.',
      'Bootstrap',
    );
  }

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
