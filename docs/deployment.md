# Deployment runbook (Fly.io demo)

This is the demo deployment path, not a production hardening guide. It assumes
one owner, one region, and a short-lived demo. Cost caps and tiers stay off
until there is a second user.

## What runs where

| Piece | Fly app | Notes |
|---|---|---|
| API | `adhd-planner-api` process `api` | workers disabled |
| Ingestion + reminder workers | `adhd-planner-api` process `worker` | same image |
| Web | `adhd-planner-web` | Next.js, `NEXT_PUBLIC_API_URL` baked in |
| Postgres | Neon or Fly Postgres | must support `vector` |
| Redis | Upstash | BullMQ needs `maxRetriesPerRequest: null` |
| Object storage | Cloudflare R2 or Fly Tigris | S3 API, private bucket |

The API image is one artifact with two process groups; the split is env-only
because the queue boundary already exists.

## First-time setup

1. `fly apps create adhd-planner-api` and `fly apps create adhd-planner-web`.
2. Create Postgres with the `vector` extension and run
   `CREATE EXTENSION IF NOT EXISTS vector;`.
3. Create a private bucket and an access key limited to it.
4. Set API secrets:

   ```sh
   fly secrets set -c fly.api.toml \
     DATABASE_URL=... REDIS_URL=... \
     CLERK_SECRET_KEY=... CLERK_PUBLISHABLE_KEY=... \
     CORS_ORIGINS=https://adhd-planner-web.fly.dev \
     MINIO_ENDPOINT=https://... MINIO_BUCKET=voice-memos \
     MINIO_ACCESS_KEY=... MINIO_SECRET_KEY=... \
     OPENAI_API_KEY=...
   ```

   `CORS_ORIGINS` must be the exact web origin; there is no wildcard.
5. Deploy the API: `fly deploy -c fly.api.toml`. The release command runs
   `prisma migrate deploy` before the new machines take traffic.
6. Deploy the web app with the API URL as a build arg:

   ```sh
   fly deploy -c fly.web.toml \
     --build-arg NEXT_PUBLIC_API_URL=https://adhd-planner-api.fly.dev
   ```
7. Point Clerk at the deployed origins and use a production instance. The live
   smoke test is `CLERK_LIVE_SMOKE=1 pnpm --filter @adhd/api test -- clerk-live`.
8. Build the phone app with EAS, with `EXPO_PUBLIC_API_URL` set to the API and
   `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` set to the production publishable key.

## Smoke test after every deploy

```sh
curl -fsS https://adhd-planner-api.fly.dev/health
```

Expect 200 and `"status":"ok"`. A 503 names the failing dependency. Then sign in
on the web app and complete one task; the stats header must move.

## Rollback

- API: `fly releases -c fly.api.toml`, then `fly deploy --image <previous>` or
  `fly releases rollback <version> -c fly.api.toml`.
- Web: same with `fly.web.toml`.
- Migrations are forward-only. A rollback that crosses a migration needs a
  compensating migration, not a schema revert.

## Known gaps

- No Sentry or structured log shipping yet; `fly logs` is the only view.
- Push credentials (FCM v1, APNs) are not wired.
- The worker and API share one app, so scaling the API also scales the worker
  process group unless `fly scale count` is set per process.
