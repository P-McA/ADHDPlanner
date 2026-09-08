# Project: Gamified AI Task Tracker

## Context
Read docs/adhd_tracker.md for full system design. We are currently in Phase 1.

## Current Phase: Phase 1 — MVP (task management + multimodal input)
Task CRUD with statuses, due dates, manual priorities; core gamification
(XP on completion, daily streaks, level display, 3–5 starter badges); voice
and image capture that extract task *drafts* for user confirmation; push
reminders; a "break this into steps" LLM call.

Human-in-the-loop is non-negotiable: AI-extracted tasks are drafts until the
user confirms them. Never auto-create.

Out of scope — flag it if a request bleeds into these:
- Dynamic priority scoring, LOE estimation, predictive task generation,
  quests/leaderboards (Phase 2)
- Agents of any kind, MCP tool layer, recurring tasks (Phase 3)

Phase 0 is complete: Turborepo monorepo (apps/api NestJS, apps/web Next.js,
packages/shared types), Node 24, pnpm, lint/typecheck/test/build all green.
Docker-compose (PostgreSQL 16 + Redis) is wired, Prisma is connected through
the pg driver adapter, and GET /health probes both dependencies and reports
each (`test/health.e2e-spec.ts` hits both for real). The users + tasks schema
carries the Phase 1 fields (`source`, `parent_task_id`); only the Phase 2
scoring columns are deferred.

CI is done: `.github/workflows/ci.yml` runs on pushes and PRs to `main`.
A `verify` job runs lint, typecheck, test and build with `TURBO_FORCE=true`, so
nothing is replayed from cache; an `e2e` job brings up Postgres 16 and Redis 7
service containers, applies migrations with `prisma migrate deploy`, and runs
the e2e suite against them. The check behind this claim is a green run of both
jobs on the commit that added them:
https://github.com/P-McA/ADHDPlanner/actions/runs/34165940374

Branch protection is NOT in place, so nothing stops a red commit landing on
`main` — the run link above is a snapshot, not a standing guarantee. Both the
classic protected-branch API and repository rulesets return 403 "Upgrade to
GitHub Pro or make this repository public": the gate is the plan, not the
tooling, so the GitHub UI cannot set it either. Unblocked by making the repo
public or upgrading; the settings to apply are in the commit message for this
change.

Object storage now has a check: `/health` head-buckets it alongside the
Postgres and Redis probes and degrades to 503 with the same semantics — see
Phase 1.4 below. The `dependencies` key is `storage`, named for the role rather
than the product, because it is MinIO locally and S3/R2 deployed.

Phase 1.2 is complete: Clerk is wired (`clerkMiddleware()` + `ClerkAuthGuard`,
which upserts the local user from the Clerk subject on first request) and task
CRUD is in place behind it. Every query is scoped to the session's user id, and
a task belonging to someone else returns 404 rather than 403 so ownership and
existence stay indistinguishable from outside. Guarded routes need real
`CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY` values to answer anything but 401 —
see apps/api/.env.example.

The one gap with no check behind it: verifying a *genuine* Clerk token, i.e.
that a valid session is *accepted*. That needs a live tenant and belongs in a
smoke test against a deployed environment, not in CI. `test/auth.e2e-spec.ts`
covers the other direction — every guarded route 401s, /health stays public —
which is what catches a guard left off a controller. It is hermetic: it blocks
outbound `fetch` for the whole suite and asserts nothing reached the network,
so it gives the same answer on a runner with no DNS. That trap is not vacuous:
feeding the middleware a structurally valid JWT makes it record five blocked
calls to api.clerk.com/v1/jwks.

## Phase 1.3 — Gamification core ✅
- XP ledger (xp_events, append-only — no update/delete paths exist in src), streaks,
  derived levels (100 XP/level, never stored)
- XP awarded only on pending→done transition via atomic conditional updateMany
  (race-safe under concurrent PATCHes; loser's response is byte-identical to winner's)
- XP + streak update in one transaction; failure rolls back both AND the task's
  completedAt (verified by mock-rejecting touchStreak inside the window)
- Streak day boundaries in the user's timezone (users.timezone), never server time
- Draft/completion semantics: completedAt stamped on completion, cleared on reopen
- Proving checks: double-completion idempotency (mutation-tested, both directions),
  10-way concurrent burst test (old read-then-write design provably fails it),
  timezone UTC-disagreement pair, cross-user isolation
- Also record: e2e specs bind one port via app.listen(0) — see vitest.e2e.config.ts
  note; supertest's per-request listen/close caused a CI-only ECONNRESET flake (fixed,
  fb4af65)

## Web client ✅
- `apps/web/src/lib/api-client.ts` is the only place the app talks to the API;
  types come from `@adhd/shared`, base URL from `NEXT_PUBLIC_API_URL`
  (declared in turbo.json — strict env mode). A 401/403 becomes a named
  "not signed in" state rather than an empty list.
- Three views: open/done tabs, AI drafts hidden behind an explicit toggle with
  their own badge, stats header refetched after a completion (never guessed —
  level and streak are server-derived from the user's timezone).
- Dev sign-in: the client sends `x-dev-user` only when `NEXT_PUBLIC_DEV_MODE`
  is `true`; the API honours it only under its own server-side
  `DEV_AUTH_BYPASS` outside production. A `NEXT_PUBLIC_` value is in the
  bundle, so it can never be what protects a route. Two opposing guard tests
  keep the real Clerk path unchanged.
- Clerk is mounted only when `CLERK_PUBLISHABLE_KEY` looks real:
  `clerkMiddleware()` throws per-request on a placeholder key, which used to
  500 every route including public `/health`.

## Phase 1.4 — Voice ingestion, Milestone A (storage + upload) ✅
- MinIO in docker-compose (127.0.0.1-bound like PG/Redis; console on host 9011,
  9001 is taken on this machine). Private bucket `voice-memos`.
- Bucket creation is app-side (`StorageService.onModuleInit` head-then-create),
  NOT an mc init container: compose only exists locally, so an init container
  would leave deployments with no equivalent step. It never blocks boot — a
  deployed credential that cannot create buckets yields honest /health output
  rather than a crash loop.
- `/health` probes storage too; all three dependencies visible, 503 when any is
  down. Checks: `test/ingestion.e2e-spec.ts` points a second app at a closed
  port and asserts 503 + which dependency failed (runs in CI, where the test
  process has no docker CLI); manually verified by stopping the real container.
- `ingestion_records` (migration 20260908063314) — every state change is a DB
  write, so a crashed worker leaves a trail.
- POST /ingestion/audio: multipart, audio/* only, 25 MB cap (the design doc
  specifies no number — this is our choice), key `{userId}/{uuid}.webm` taken
  from the session and never from the request body. 202 + record id, enqueues
  BullMQ `audio-ingestion` with the record id as jobId (idempotency key).
- If the enqueue fails, the request still returns 202 (bytes and row are
  durable) but the record moves to `failed` with `enqueue failed: <msg>`. Left
  on `uploaded` it would be indistinguishable from a job waiting its turn, so
  nothing would ever notice it was dropped. Re-enqueueing is out of scope.
- Multer's `limits.fileSize` truncates silently rather than erroring, so the
  limit is set to cap+1 and the explicit check returns 413. Both sides of the
  boundary are tested (exactly-at-cap → 202, cap+1 → 413, no row left behind).
- The fence has a check: an accepted upload creates a row and nothing else —
  `creates no task` in the e2e suite fails if anything auto-creates a task.
- The doc calls this table `media_inputs`; we use `ingestion_records`.
- No worker yet — jobs accumulate in Redis by design. Milestone B.

Still open in Phase 1: transcription + extraction worker (Milestone B), image
capture, push reminders, and the "break this into steps" call.

## Stack (non-negotiable)
- Turborepo monorepo, TypeScript strict mode everywhere
- Backend: NestJS (apps/api) on the Express platform; `@types/express` is an
  approved devDependency (Express 5 — keep the major in step with
  `@nestjs/platform-express`)
- DB: PostgreSQL via Prisma ORM (`@prisma/adapter-pg` driver adapter);
  Redis via `ioredis` for cache/queues
- Auth: Clerk (OIDC) — do not hand-roll auth
- Frontend Next.js 14+ (apps/web), Expo (apps/mobile)
- Shared types in packages/shared — API and clients must import from here

## Rules
- Ask before adding any dependency not listed above
- Every new module needs tests (Vitest for API, Jest/RTL for web)
- Prefer vertical slices: schema → service → controller → test
- Do not skip Phase scope: if a request bleeds into Phase 2+ features, flag it
- Run `pnpm lint && pnpm test` before declaring any task done
- Every "done" claim in the progress section must map to a check that would
  fail if the thing were missing. No check = not done = don't claim it.

## Commands
- `docker compose up -d` — PostgreSQL (host port 5434) + Redis for local dev
- `pnpm dev:api` — run API locally (needs the compose services up)
- `pnpm test` — unit tests (no infrastructure required)
- `pnpm test:e2e` — API e2e suite; needs the compose services up
- `pnpm db:migrate` — Prisma migrations
- `pnpm --filter @adhd/api db:generate` — regenerate the Prisma client after a
  schema change (a stale client fails at runtime, not at typecheck)
