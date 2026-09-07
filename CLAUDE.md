# Project: Gamified AI Task Tracker

## Context
Read docs/adhd_tracker.md for full system design. We are currently in Phase 0.

## Current Phase: Phase 0 — Foundation
Monorepo, CI/CD, PostgreSQL + Redis + S3 connectivity, auth, API skeleton,
task CRUD shell. NO AI features yet. NO gamification yet. NO agents.

## Stack (non-negotiable)
- Turborepo monorepo, TypeScript strict mode everywhere
- Backend: NestJS (apps/api)
- DB: PostgreSQL via Prisma ORM; Redis for cache/queues
- Auth: Clerk (OIDC) — do not hand-roll auth
- Frontend Next.js 14+ (apps/web), Expo (apps/mobile)
- Shared types in packages/shared — API and clients must import from here

## Rules
- Ask before adding any dependency not listed above
- Every new module needs tests (Vitest for API, Jest/RTL for web)
- Prefer vertical slices: schema → service → controller → test
- Do not skip Phase scope: if a request bleeds into Phase 1+ features, flag it
- Run `pnpm lint && pnpm test` before declaring any task done

## Commands
- `pnpm dev:api` — run API locally (docker-compose for PG/Redis)
- `pnpm test` — all tests
- `pnpm db:migrate` — Prisma migrations
