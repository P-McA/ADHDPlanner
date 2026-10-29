# Project progress

Last updated: 2026-10-29
Phase: 2 — Intelligence Layer

This is a status snapshot. `CLAUDE.md` remains the source of truth for scope
and working rules; `docs/adhd_tracker.md` holds the design and phase plan.

## Shipped

Phase 1 (MVP) closed 2026-10-08. Phase 2 slices A–D (steps, LOE, Next up,
predictions) shipped 2026-10-09. The following shipped on 2026-10-29, each with
checks:

- Timezone truth (`PATCH /me`, shared IANA predicate, both clients).
- Mobile UI pass (tokens, quick add, themed rows, calm home).
- Deploy scaffolding (API/web Dockerfiles, Fly configs, boot-time env checks).
- Push registration, image input, streak freezes, weekly digest, onboarding.
- Demo seed, `AI_KILL_SWITCH`, `docs/demo.md`.
- Expo SDK 58 upgrade and the `expo/fetch` multipart fix.
- Configurable tracking: `trackingMode` (`metrics` default, `xp` opt-in),
  `showElo`, append-only `performance_events`, `tasks.startedAt`,
  `GET /me/activity`, Start actions, onboarding picker, colour-coded header.
  Evidence: `.claude/tdd/tracking-modes.tdd.md`.

## Verification

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` pass with cache
  bypassed.
- Full e2e: 284/284.
- Mutation pass on the tracking feature: six mutations each failed exactly
  their own tests, then were restored.

## Open

1. Deploy to Fly (`docs/deployment.md`): apps, secrets, Neon/Upstash/R2, Clerk
   production, EAS build, FCM v1/APNs, device acceptance.
2. Verify live: predictions with real history, a real photo to the vision
   model, a real push, the digest on a real Monday.
3. Phase 2 leftovers: provider fallback, AMR transcode, zod response contracts,
   offline sync, quests/leaderboards.
4. Rehearse `docs/demo.md` and record the fallback.

## Decisions still open

- Fly region and managed-service choices.
- Sentry/pino and Playwright/Maestro approvals.
- Whether leaderboards wait for user density.

## Known gaps

- No backfill of performance events for pre-existing completed tasks; history
  starts at launch (owner decision).
- `performance_events` reads are time-bounded but not row-bounded.
- The API has no rate limiting; `/me/activity` inherits that gap.
