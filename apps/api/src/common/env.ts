/**
 * Boot-time environment checks for deployed processes.
 *
 * Local development tolerates a half-filled `.env`: the API boots, `/health`
 * reports the truth, and a missing provider key parks a memo on `failed`
 * instead of crashing. A deployment is different — a missing `DATABASE_URL`
 * discovered on the first request is a 500 with no clue, and a missing
 * `CORS_ORIGINS` is a browser that silently cannot call the API. Fail at boot,
 * name every missing variable at once, and let the platform restart loop show
 * it.
 */

/** Variables a deployed API or worker cannot do without. */
export const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'REDIS_URL',
  'CLERK_SECRET_KEY',
  'CLERK_PUBLISHABLE_KEY',
  'CORS_ORIGINS',
  'MINIO_ENDPOINT',
  'MINIO_BUCKET',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
] as const;

/**
 * The required variables that are absent or blank.
 *
 * Returns the whole list rather than the first, so one boot names every fix
 * instead of one per deploy.
 */
export function missingProductionEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return REQUIRED_IN_PRODUCTION.filter((name) => {
    const value = env[name];

    return value === undefined || value.trim() === '';
  });
}

/**
 * Throws when this is a production process with an incomplete environment.
 *
 * Outside production it does nothing: the dev bypass and the local compose
 * defaults are legitimate ways to run with fewer variables.
 */
export function assertProductionEnv(env: Record<string, string | undefined> = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const missing = missingProductionEnv(env);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
