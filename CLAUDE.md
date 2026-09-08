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
- The worker that drains this queue arrived in Milestone B, below.

## Phase 1.4 — Voice ingestion, Milestone B (transcription + extraction) ✅
- The pipeline (`AudioIngestionProcessor`) is deliberately split from the queue
  subscription (`AudioIngestionWorker`): the whole state machine is a plain
  method taking a record id, so tests drive every transition without Redis and
  the e2e suite asserts on a settled record instead of racing a live consumer.
  Check: `audio-ingestion.processor.spec.ts` (12 tests) runs the entire machine
  with no queue at all.
- Statuses: `uploaded → transcribing → extracting → draft_created | failed`.
  Every arrow is a DB write before the call it precedes, so a crash is always
  attributable. Check: `walks the record through every stage, writing each one
  down` asserts the exact transition sequence.
- **The processor never throws.** BullMQ `attempts: 3` therefore only covers a
  crashed worker, never a provider failure — re-running a metered Whisper/LLM
  call that already burned its deadline is the wrong default, and the record
  carries the error for a human instead. Checks: `records a transcription
  failure on the row and does not throw`, `records an extraction failure on the
  row, keeping the transcript`, `records a storage failure without ever calling
  a provider`.
- Resumable: a record that already has a transcript skips transcription, so a
  crash between the two stages costs a cheap extraction rather than a second
  Whisper bill. Checks: `resumes at extraction rather than paying for a second
  transcription` (unit) and its e2e twin, which asserts the transcriber was
  never called.
- Draft creation and the terminal status are one `$transaction`, so a duplicate
  delivery cannot half-duplicate drafts. The idempotency proof is `does not
  double the drafts when the same job is delivered twice` (e2e): it processes
  one record id twice with a two-candidate extractor and a transcriber that
  returns a different string on every call, then asserts exactly 2 draft rows,
  the *first* transcript still stored, and one call to each provider.
  Mutation-tested both directions against the terminal-status guard in
  `AudioIngestionProcessor.process`:
  - guard deleted → e2e 1 failed / 89 passed (`expected 4 to be 2`), unit
    2 failed / 125 passed (`does nothing for a record that already produced
    drafts`, `does not silently re-run a record that already failed`). Only the
    tests that exist to pin the guard fail.
  - guard inverted so it always fires → e2e 12 failed, unit 10 failed,
    including the doubling test. So it is not passing vacuously on a no-op:
    "exactly 2" fails at 0 as well as at 4.
  - restored (file byte-identical to the pre-mutation copy) → 90/90 e2e,
    127 passed / 2 skipped unit.
- Providers sit behind two ports, `TRANSCRIBER` and `EXTRACTOR` (Symbol tokens —
  interfaces do not survive to runtime). `OpenAiTranscriber` (whisper-1) and
  `OpenAiExtractor` (gpt-4o) are thin `fetch` adapters; no vendor SDK was added,
  since Node 24 has `fetch`/`FormData`/`Blob`. Nothing outside `src/ai/` may
  import fetch-with-an-OpenAI-URL. Check: the e2e suite overrides both tokens
  with fixtures from `test/fakes/ai.fakes.ts` and passes with no network.
- Both calls carry a deadline — `AbortSignal.timeout`, 60 s transcription /
  30 s extraction (`TRANSCRIPTION_TIMEOUT_MS`/`EXTRACTION_TIMEOUT_MS` in
  `@adhd/shared`). A hung provider becomes a `failed` record with the error
  stored, not a worker that never returns. Check: `parks the record on failed
  when a provider call times out` asserts `process()` *resolves*, and the fake
  reproduces the real `TimeoutError`.
- Extraction is `temperature: 0` + `response_format: json_object`: the same memo
  must yield the same drafts. It is extraction, not authorship — sampling
  variety would be a bug. Check: `asks for deterministic JSON and attaches the
  documented deadline`.
- The prompt is biased toward under-extraction, and the adapter enforces it: a
  row with no usable title is dropped, and `dueAt`/`manualPriority` are nulled
  unless they parse. A draft whose fields were invented looks more considered
  than it is, and the user pays for that in review time. Checks: `drops a row
  with no usable title instead of guessing one`, `nulls a due date or priority
  it cannot trust rather than storing nonsense`, `returns nothing for a memo
  with nothing in it, rather than reaching`.
- `OPENAI_API_KEY` is resolved lazily, per call, not at construction: the API
  boots and the whole suite runs without one. Checks: `refuses to call the
  provider at all with no key, and says what to do` (asserts nothing left the
  process). Declared in `turbo.json` for `dev`/`test`/`test:e2e` — strict env
  mode — and in `apps/api/.env.example`. `test/load-env.ts` deletes it, so no
  test run can ever spend a developer's real key.
- `src/ai/openai.integration.spec.ts` is the one test that talks to OpenAI:
  `describe.skipIf(!hasKey)`, asserting shape not wording. It is the skipped
  file in a normal `pnpm test` run — that skip *is* the key-gating check.
- A draft is `source = 'ai_suggested' AND confirmedAt IS NULL`, defined once in
  `@adhd/shared` (`isTaskDraft`) and imported by API, processor and web. The old
  source-only check in the web row was a real bug: an approved suggestion kept
  its badge forever. Check: `drops the badge once the user approves the
  suggestion` serves the refetched task with `source` still `ai_suggested` and
  `confirmedAt` set, so a source-only badge survives and fails the test.
- Confirmation is an act, not an edit: `POST /tasks/:id/approve` and
  `/reject`. `UpdateTaskInput` deliberately cannot carry `confirmedAt`, and the
  approve/reject guard lives in the WHERE clause, so the database makes it
  idempotent. Reject archives and leaves `confirmedAt` null — the user declined
  it, they did not confirm it into the bin. Checks: `cannot be confirmed through
  PATCH, only through the approve route`, `is idempotent — a second approve does
  not move the timestamp`, `archives a rejected draft and leaves it
  unconfirmed`, `404s rather than 403s when the draft belongs to someone else`.
- `INGESTION_WORKER_DISABLED=true` stops the worker subscribing; jobs then wait
  in Redis. `test/load-env.ts` sets it for the whole e2e suite so no background
  consumer competes with the test's own `processor.process()` call.
- The `ready` value was removed from `IngestionStatus` (shared + Prisma,
  migration `20260908114500_drop_unused_ready_status`). No transition produces
  it, and the schema's own rule is that carrying a value the code cannot emit is
  dead schema. Postgres has no `ALTER TYPE … DROP VALUE`, so the migration
  rebuilds the type behind a `RAISE EXCEPTION` guard that aborts if any row
  still holds it.
- The worker runs in-process with the API, not as a separate deployment. Two
  concurrent jobs, and the split above means promoting it to its own process
  later is a wiring change, not a rewrite.
- The draft fence, all four halves of it, now enforced by the API:
  - Drafts are only ever created with `source='ai_suggested'` and
    `confirmedAt=null`. Check: `produces drafts, not tasks — the fence holds at
    the end of the pipeline`.
  - `confirmedAt` is writable only through `POST /tasks/:id/approve`. Check:
    `cannot be confirmed through PATCH, only through the approve route`.
  - `GET /tasks` excludes unconfirmed drafts by default; `?include=drafts` opts
    in, and any other `include` value is a 400 rather than a silent fenced page.
    The filter is `NOT (source='ai_suggested' AND confirmedAt IS NULL)` — the
    pair, so an approved suggestion keeps its provenance and stays in the list.
    `total` carries the same filter. Checks: `leaves unconfirmed AI drafts out
    of the default page`, `returns them when the caller opts in with
    ?include=drafts`, `keeps an approved suggestion in the default page`, `still
    hides a draft when a status filter is also applied`, `rejects an include
    value it does not understand with 400`. Mutation: drop the `NOT` clause →
    2 e2e + 2 unit fail, nothing else.
  - `PATCH {status:'done'}` on an unconfirmed draft is **409**, not 404: the row
    exists and the caller owns it, so the state is what is wrong and saying so
    is the useful answer (404 stays reserved for someone else's task, which is
    hiding existence — a different job). Only `done` is fenced; editing a draft
    or moving it to `in_progress` is ordinary review work and pays nothing.
    Checks: `refuses to complete an unconfirmed draft, and pays no XP for it`
    (asserts the 409, that the row is untouched, *and* that totalXp did not
    move), `lets the same request through once the draft is approved`, `still
    allows editing a draft before it is approved`. Mutation: delete the guard →
    exactly those two tests fail (1 e2e, 1 unit), nothing else.
  - The web client now passes `include: 'drafts'` explicitly, because it has a
    review surface to put them in. Check: `asks the API for drafts, which it no
    longer sends by default`.
- **Distrust any claim that a fence is server-side unless a test in
  `tasks.e2e-spec.ts` hits the endpoint.** Until this change the entire
  draft-listing fence lived in `task-dashboard.tsx`, and the only checks were
  Jest tests rendering the component against a stubbed fetch
  (`hides AI drafts until the toggle is switched on`). Those pass whatever the
  API does — the fixture decides what the list contains — so they read like
  proof of a fence while proving only that the component filters an array
  someone handed it. Nothing was ever recorded claiming the API excluded
  drafts, and no such test drifted or was deleted: the behaviour simply did not
  exist, and the client-side check was mistaken for it. The general shape of
  the error is worth remembering — *a test that mocks the boundary it is meant
  to be proving will always agree with you.* The e2e tests above are the ones
  that can actually fail, which is why the mutation runs are recorded next to
  them.
  - `creates no task — extraction has not run and drafts need confirming`
    counts every task for the user right after the 202. With the worker
    disabled that is deterministic. Run with `INGESTION_WORKER_DISABLED=false`
    it still passed, but only because the consumer had not got there yet — it
    is a race under a live worker, and two provider-call-count assertions in
    the same file do fail that way. The invariant that survives a live worker is
    the draft-ness one above, not the count.

## Phase 1.5 — Milestone A (scope ledger + review XP) ✅

**The scope ledger.** `docs/adhd_tracker.md` now carries a "moved out of Phase
1" table: offline-first sync, image input, the break-into-steps button,
provider retry policies, and a re-enqueue route, each with the reason it is
Phase 2 rather than missing. That replaces the vague "still open in Phase 1"
line this section used to end with. Nothing in it is blocked on an open
decision; they are all "not now".

**Starter badges are Phase 1.5, not Phase 2.** The old comment on `XpEventType`
— in both `packages/shared/src/gamification.ts` and `schema.prisma`, where it
had also drifted above the wrong enum — said badges were Phase 2. They are not.
Both comments now say so, and say why `badge` is still not an XP event type: a
badge is something the user *has*, which wants its own table, not a ledger row
worth zero XP. `quest` is genuinely Phase 2. The three starter badges
themselves are unimplemented and unassigned — milestones A–D never gave them a
home. Flagged, not silently dropped.

**1 XP for reviewing an AI suggestion, approve or reject.** Key decision #2 in
the doc, the data flywheel. `XP_DRAFT_REVIEW = 1` in shared, a `draft_reviewed`
value on the enum (additive migration `20260908150000_add_draft_reviewed_xp_event`),
and `GamificationService.awardForDraftReview` writing the ledger row.

- Reject pays the same as approve, pinned by
  `pays exactly the same for rejecting one`. If that ever drifts below approve
  the app is paying people to say yes.
- One value, not an approved/rejected pair: the direction is already on the
  task row (`confirmedAt` set, or `archived`), and one value makes "has this
  draft been paid for" a single condition.
- No streak touch, pinned by
  `does not let reviewing stand in for finishing something`. A tap on Reject
  keeping a 40-day run alive would make the streak measure attendance.
- Nothing is paid for approving a hand-typed task —
  `pays nothing for approving a task the user typed themselves`.
- 404 before any write or payment for a stranger's draft —
  `pays nobody for reviewing another user's draft`.

**Idempotency is one WHERE clause, not a read-then-write.** `approveDraft` and
`rejectDraft` share `reviewDraft`, whose `updateMany` matches
`source: ai_suggested, confirmedAt: null, status: { not: 'archived' }` — a
state each draft leaves exactly once and never returns to. XP is paid only when
`count === 1`, in the same transaction as the flip. The added
`status: { not: 'archived' }` also makes rejection final, which is what closes
reject-then-approve as a two-tap XP tap on one suggestion.

Mutation runs, both directions:

- Payment gate broken (`claim.count === 1` → `>= 0`, i.e. always pay): e2e
  4 failed / 103 passed —
  `pays once no matter how many times approve is pressed`,
  `…reject is pressed`, `pays nothing more for approving a suggestion already
  rejected`, `pays nothing for approving a task the user typed themselves`;
  unit 1 failed / 134 passed —
  `pays nothing when the conditional update matched no row`. Nothing else moved.
- `status: { not: 'archived' }` deleted from the guard: e2e 2 failed / 105
  passed — `pays once no matter how many times reject is pressed`,
  `pays nothing more for approving a suggestion already rejected`; unit 3
  failed / 132 passed — the two new WHERE-clause assertions plus the
  pre-existing `confirms a draft, which is the only way confirmedAt is ever
  written`.
- Restored (file byte-identical to the pre-mutation copy, sha256 checked):
  107/107 e2e, 135 passed / 2 skipped unit, `pnpm lint` and `pnpm test` green.

The unit spec asserts the WHERE clause field by field; whether the XP actually
lands is proved only against Postgres in the e2e. That split is deliberate
under the mock-the-boundary rule below — a mocked ledger agrees with whatever
the service does.

## Phase 1.5 — Milestone B (retention: erasing a memo) ✅

`DELETE /ingestion/:id` — **not** `/ingestion/records/:id` as the brief wrote
it. The controller is already mounted at `ingestion`, and `GET /ingestion` /
`GET /ingestion/:id` address records directly; a `records` segment on the
delete alone would be the only route in the app whose path disagrees with its
siblings. Flagged rather than assumed.

**Soft delete via `deletedAt`, not an `IngestionStatus` value.** The status is
a pipeline state machine, and the processor's terminal-status guard reads
exactly `draft_created` and `failed` — a `deleted` status would fall outside
it and quietly make an erased record re-processable, re-downloading an object
that is gone. It would also destroy the account of what happened to the memo,
which is the reason the row survives at all. Migration
`20260908160000_retain_xp_ledger_and_soft_delete_records`.

**Order is the safety argument: object first, row second.** `DeleteObject`
succeeds on a key that is already absent, so a storage failure aborts the
request with the database untouched and the retry works. The other order —
mark the row, then fail — leaves the file in the bucket with nothing pointing
at it, which is precisely the orphaned object this route exists to prevent,
now unreachable by any code path. Checks: `erases the object before it touches
the row` (asserts the call order `remove → deleteMany → update`), `aborts with
the row untouched when storage refuses`.

**What survives, and why.** The drafts predicate is the full `isTaskDraft`
pair — `source='ai_suggested' AND confirmedAt IS NULL` — so a suggestion the
user approved is *theirs*, not the memo's, and stays. The XP it paid stays
with it: `xp_events.task_id` is now nullable with `ON DELETE SET NULL`, so
deleting a task detaches the ledger row instead of taking it. The ledger's
claim is "this XP was legitimately earned at this time", and that outlives the
entity. It is also the anti-farm rule — if deleting refunded XP, complete →
earn → delete → repeat would be the cheapest XP in the app. Checks: `keeps a
suggestion the user approved, and the XP it paid`, and in `tasks.e2e-spec.ts`
`keeps the XP a deleted task paid, with the ledger row detached` (ledger row
present, `taskId` null, `totalXp` unchanged).

The FK change breaks e2e isolation as a side effect — `xp_events` no longer
cascade away when a test deletes its tasks — so `tasks.e2e-spec.ts`'s
`beforeEach` now clears them explicitly.

**Erased memos leave the working view but stay inspectable.** `list()` filters
`deletedAt: null`; `findOne` does not, so the user can still see *that* a memo
was erased and what it did before that. `transcript` is nulled (it is a copy
of what the audio said, so keeping it would erase nothing); `status` and
`error` stay. A second DELETE keeps the first `deletedAt` — the timestamp
records when the memo was erased, not when someone last pressed the button.
Checks: `drops it from the uploads list`, `leaves the record inspectable, with
the account of what happened to it`, `is a no-op the second time, and does not
restamp the deletion`.

**"Object gone from the bucket" is proved against real MinIO, not a stubbed
`StorageService`.** The brief allowed either. A stub would assert that the
service called the method we wrote — the mock-the-boundary error again, in the
one place the whole route exists to have an effect. The e2e HEADs the key
through the real client and requires a `NotFound`.

Mutation runs (each restored byte-identical, sha256 checked):

- `confirmedAt: null` dropped from the draft predicate: unit 1 failed / 140
  passed (`deletes only the drafts nobody confirmed`), e2e 1 failed / 114
  passed (`keeps a suggestion the user approved, and the XP it paid`).
- Object deletion moved *after* the row write: unit 2 failed / 139 passed —
  `erases the object before it touches the row`, `aborts with the row
  untouched when storage refuses`. Nothing else.
- Ownership scope dropped from `remove`'s lookup (`{ id, userId }` → `{ id }`):
  unit 1 failed / 140 passed (`404s without erasing anything when the record is
  not the caller's`), e2e 1 failed / 114 passed (`404s rather than 403s on
  another user's memo, and erases nothing`).
- `record.deletedAt ?? new Date()` → `new Date()`, and `list`'s `deletedAt:
  null` filter removed, together: unit 2 failed / 139 passed (`lists only the
  caller's rows, newest first`, `keeps the first deletion timestamp on a second
  call`), e2e 2 failed / 113 passed (`drops it from the uploads list`, `is a
  no-op the second time, and does not restamp the deletion`).
- `StorageService.remove` made a no-op: e2e 1 failed / 114 passed — `removes
  the object from the bucket`, and only that. This is the mutation a stubbed
  storage test could not have caught.
- Restored: unit 141 passed / 2 skipped, e2e 115/115, `pnpm lint` and
  `pnpm test` green (web 36/36).

**The orphaned-objects gap is closed.** It was never written down in this file
— it lived in the Milestone A report — so there is no line here to flip; this
section is the record. Uploaded audio now has a user-reachable delete path, and
`removes the object from the bucket` fails if it stops working.

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
