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

NOT done, despite an earlier claim here to the contrary: there is no CI. No
workflow file exists anywhere in the repo. S3 connectivity is also still
outstanding.

Phase 1.2 is complete: Clerk is wired (`clerkMiddleware()` + `ClerkAuthGuard`,
which upserts the local user from the Clerk subject on first request) and task
CRUD is in place behind it. Every query is scoped to the session's user id, and
a task belonging to someone else returns 404 rather than 403 so ownership and
existence stay indistinguishable from outside. Guarded routes need real
`CLERK_SECRET_KEY`/`CLERK_PUBLISHABLE_KEY` values to answer anything but 401 —
see apps/api/.env.example.

The one gap with no check behind it: verifying a *genuine* Clerk token. That
needs a live tenant. `test/auth.e2e-spec.ts` covers the unauthenticated path
(every guarded route 401s, /health stays public) with a bogus key, which is
what catches a guard left off a controller.

Still open in Phase 1: gamification, voice/image capture, push reminders, the
"break this into steps" call, and the web client's use of the task API.

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
