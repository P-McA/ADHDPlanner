# Project: Gamified AI Task Tracker

## Context
Read docs/adhd_tracker.md for full system design. We are currently in
**Phase 2** — Phase 1 closed 2026-10-08 (see "Phase 1 closure" below). The
Phase 2 milestone plan and the day-2 tier model live in docs/adhd_tracker.md.

## Current Phase: Phase 2 — Intelligence Layer
Dynamic prioritisation, LOE estimation, predictive task generation, expanded
gamification, plus the items deferred out of Phase 1 (image input,
break-into-steps, offline sync, retry policy + re-enqueue). Milestone order is
in docs/adhd_tracker.md "Phase 2 plan". Every architect-proposed technology
there (zod, Sentry/pino, Maestro/Playwright, deploy target) still needs owner
approval under the dependency rule before it is added.

Human-in-the-loop is still non-negotiable: AI-produced tasks, subtasks, LOE
estimates and predictions are drafts until the user confirms them.

Out of scope — flag it if a request bleeds into these:
- Agents of any kind, MCP tool layer, recurring tasks (Phase 3). The
  once-per-day XP rule is a payout rule, not a schedule — keep it that way.
- AI spend limits / tiers: **decided but deliberately not built** while there
  is one user (docs/adhd_tracker.md "Day-2 items").

## Phase 1 — MVP (closed 2026-10-08)
Task CRUD with statuses, due dates, manual priorities; core gamification
(XP on completion, daily streaks, level display, 3–5 starter badges); voice
and image capture that extract task *drafts* for user confirmation; push
reminders; a "break this into steps" LLM call.

Human-in-the-loop is non-negotiable: AI-extracted tasks are drafts until the
user confirms them. Never auto-create.

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

## Phase 1.5 — Milestone C (the Expo shell) ✅

`apps/mobile`: sign-in gate, stats header, task list with a complete action, a
suggestions section, and one voice-memo upload. Types come from `@adhd/shared`
and are never restated — same rule as the web client.

**The point of this milestone is `apps/api/test/mobile-client.e2e-spec.ts`, not
the components.** `apps/mobile/src/lib/api-client.ts` deliberately imports
nothing from React Native, so it can be imported by an API e2e spec and run
against a real Nest app on a real port in front of real Postgres. What is under
test there is the phone's own code: its paths, its query string, its headers,
its multipart body, its error mapping. Ten tests. The alternative — React Native
Testing Library over a stubbed `fetch` — is the fence incident again, and would
have proved nothing about the API.

**That spec runs the unmocked `ClerkAuthGuard`.** Every other e2e file overrides
it with a fake reading `x-test-user`. This one arms `DEV_AUTH_BYPASS` in-process
and lets the real guard read the `x-dev-user` header the client sends, because
the claim being made is that mobile's dev sign-in is *server-gated* and a fake
guard cannot support it. Checks: `signs in with the dev header, through the
guard that decides whether to trust it`, `is refused when the server has not
armed the bypass, whatever the client sends` (client unchanged, still sending
the header — 401), `sends no dev header at all when the client-side flag is
off`. `afterAll` deletes `DEV_AUTH_BYPASS`, because e2e files share a process
(`fileParallelism: false`) and an armed bypass left behind is a global change.

**A pre-existing guard behaviour, found while writing that spec and not
introduced by it:** with the bypass disarmed, `ClerkAuthGuard` calls `getAuth()`
outside a try/catch, and that *throws* when `clerkMiddleware()` was never
mounted — so an app assembled without it answers 500 to an unauthenticated
request rather than 401. The spec mounts the middleware with placeholder keys,
mirroring `auth.e2e-spec.ts`. A real dev server started with no Clerk keys *and*
the bypass off would 500 every guarded route. Flagged, not fixed here —
**fixed in Milestone D below**, where it turned out to have a second,
independent cause in `main.ts` as well.

**Item 8, the fence, verified from the phone's side.** The API hides
unconfirmed drafts unless a request carries `include=drafts`, so the mobile
suggestions view has to opt in. It does, through a named `listDrafts()` rather
than a flag each screen has to remember. Both halves are pinned, and the
mutations show why both are needed:
- `listDrafts()` → `listTasks()` in `api-client.ts` (the opt-in dropped): e2e
  1 failed / 126 passed — `serves the phone its drafts only when it asks for
  them`, and only that. The mobile unit suite stayed 10/10 green, which is
  exactly the point: it mocks the client, so it cannot see a contract change.
- `listDrafts()` → `listTasks()` in `home-screen.tsx` (the screen stops asking):
  mobile 2 failed / 8 passed — `asks for drafts, which the API does not send by
  default` and `puts the suggestion in the suggestions section and the task in
  the task list`. The e2e suite cannot see this one; it tests the client, not
  the screen. Hence `home-screen.test.tsx`, which mocks *our own module* to
  assert the call was made, and says so in its docblock.
- Both files restored byte-identical (sha256 checked).

Also pinned server-side from the client: `does not get drafts back from the
plain list — the fence is the server's`.

**The multipart field name is now a contract, not a string.**
`AUDIO_UPLOAD_FIELD = 'file'` lives in `@adhd/shared`; the API reads it and both
clients send it, so the mismatch that cost the browser client an afternoon
cannot be written here at all. And when a hand-rolled client does make it, the
400 now names both sides. `FileInterceptor(name)` could not: multer's
`single()` refuses a differently-named part with `Unexpected field - audio`,
which names the field that arrived and never the one we wanted. The controller
takes `AnyFilesInterceptor` instead and `selectAudioUpload` does the refusing —
same rule, better diagnosis, contract not loosened. Checks: 5 unit tests on
`selectAudioUpload`, and in the e2e `names the field it wanted and the field it
got when the part is misnamed` plus `asks for the audio by name when the request
carried no file at all`.
- That e2e assertion was weak on the first pass: `not.toBe('Unexpected field')`
  would have passed against the *old* message, which was `Unexpected field -
  audio`. Caught by reverting the controller to `FileInterceptor` and reading
  what actually came back. It is `not.toContain('Unexpected field')` now.

**`expo-document-picker`, not a recorder.** Flagged as asked. It exercises the
identical multipart contract — the API cannot tell the difference — for none of
the microphone-permission, audio-session and per-platform-container work a
recorder needs. Recording is the better product and belongs in its own change.

**What no test here can reach.** React Native marshals a `{uri, name, type}`
part into a file in native code; Node has no equivalent, so the upload test
hands the same function a `Blob`. Everything the API contracts on — path,
method, field name, headers — is the same code path. And the app has never been
started on a device or a simulator: nothing in this repo runs Metro, so
"`expo start` works" is not a claim being made.

**The real Clerk session path is not implemented, and it is Phase 2.**
`setAuthTokenProvider` in
`api-client.ts` is the seam for it (a phone has no cookie jar, so it is a bearer
token rather than the web's `credentials: 'include'`). Until it is wired, an
unset `EXPO_PUBLIC_DEV_MODE` means signed out, and the gate says so on screen.

**Toolchain findings worth not rediscovering:**
- `@testing-library/react-native` 14 made `render` and `fireEvent` **async**.
  They return promises; without `await` the queries throw `render function has
  not been called`, which reads like a setup failure and is not one.
- jest-expo 57's preset opens with
  `jest.mock('@react-native/assets-registry/registry', …)`, and React Native
  0.87 does not ship that package — nothing in the graph references it
  (`grep assets-registry pnpm-lock.yaml` finds nothing), so it is not a pnpm
  layout problem. A mock still has to *resolve*, so
  `test/assets-registry-stub.js` exists to be resolvable and nothing else.
- `transformIgnorePatterns` is deliberately **absent** from
  `apps/mobile/jest.config.js`. Jest replaces the preset's value rather than
  merging it, and jest-expo's own pattern already allows `.pnpm` paths through —
  so pasting the pattern from the Expo docs silently makes things worse.
  `moduleNameMapper` *is* merged, which is why the one entry there is safe.
- `apps/mobile/src/env.d.ts` declares the three `EXPO_PUBLIC_*` variables on
  `NodeJS.ProcessEnv`. The ambient `ProcessEnv` in scope carries an `any` index
  signature, so without it every read is untyped and the `no-unsafe-*` rules
  have nothing to bite on. `/// <reference types="expo/types" />` was the
  obvious alternative and was rejected: it drags in `react-native-web`'s style
  typings, which then reject `StyleSheet.create` output on `<Text>`.
- `apps/mobile/tsconfig.json` needs an explicit `"types": ["jest"]`; automatic
  `@types` inclusion does not pick it up under this toolchain.

**The cross-package import has a real cost, and it is paid explicitly.**
`apps/api` compiles as node16 ESM; `apps/mobile` is bundled by Metro and
declares no `type`, so node16 classifies its sources as CommonJS and refuses
their import of the ESM-only `@adhd/shared` (TS1479), while `rootDir` refuses a
file outside the package (TS6059). Neither is a defect in either app — it is two
module systems meeting. So `test/mobile-client.e2e-spec.ts` is excluded from
`apps/api/tsconfig.json` and checked by `tsconfig.mobile-spec.json` (bundler
resolution, which is what Metro actually applies to that file), with both
configs run by `pnpm typecheck` and an eslint override pointing the parser at
the second one. The main config keeps node16, so the API's own imports stay
honestly checked. Adding `"type": "module"` to `apps/mobile` would have fixed
TS1479 in one line and was rejected: it changes how Jest and Metro classify
every `.js` file in the package, and no test here can tell you whether Metro
still boots.
- Both halves were probed rather than assumed: a deliberate
  `const bad: number = mobile.apiBaseUrl()` fails
  `tsc -p tsconfig.mobile-spec.json` (TS2322), and a deliberate floating promise
  fails `pnpm lint` with `@typescript-eslint/no-floating-promises`. The file is
  not silently unchecked. Restored byte-identical (sha256 checked).

Green at the end of the milestone: `pnpm lint` 5/5, `pnpm typecheck` 5/5,
`pnpm build` 3/3, `pnpm test` (shared 4, api 146 passed / 2 skipped, web 36,
mobile 10), `pnpm --filter @adhd/api test:e2e` 127/127 across 6 files.

## Phase 1.5 — Milestone D, part 1 (auth closure) ✅

Folded in ahead of the push work, because both of these were flagged-not-fixed
at the end of Milestone C and a reminder scheduler is the wrong thing to build
on top of a server that 500s. The push half is part 2, below.

**A keyless dev server now answers 401, and it used to answer 500 — by two
independent routes, either of which was enough on its own.** Both were live
simultaneously, which is why neither showed up in a suite: the e2e files all
supply placeholder keys and mount the middleware themselves.

1. `main.ts` mounted `clerkMiddleware()` when `clerkKeyLooksUsable() ||
   !devBypassArmed()`. Read the right-hand side again: turning the bypass
   *off* — the safer-looking setting — mounted Clerk **with no key**, and Clerk
   with no publishable key calls `next(err)` on every request before any route
   or guard runs. That is a 500 on the whole API, `GET /health` included: a
   health probe reporting the server unhealthy because *auth* is unconfigured.
   The rule now lives in `src/auth/clerk-mounting.ts` as `shouldMountClerk()`,
   which is the key check and nothing else. The bypass decides who may sign in;
   it has no business deciding whether a key exists, and mixing the two is what
   hid this.
2. `ClerkAuthGuard.clerkSubject` caught `getAuth`'s throw only while the bypass
   was armed, and let it escape otherwise. `getAuth` throws — rather than
   reporting an empty session — when the middleware was never mounted, so with
   the mount fixed this became the next 500 in line.

**The old behaviour was a deliberate decision, and reversing it needed an
argument, not a patch.** `lets a Clerk failure surface instead of silently
401ing` was a test with a rationale attached: a fault is not an anonymous
caller, and laundering it into "please sign in" hides it behind a login wall.
That is right about the fault and wrong about the remedy. A 500 is not how an
operator finds out — it is only how every caller finds out, including an
anonymous stranger, who now knows the server is misconfigured. So the wire
answer is 401 and fail-closed, and the fault is logged at error level with the
underlying stack. The test is inverted rather than deleted, and the half worth
keeping is pinned separately: `says so loudly in the log rather than swallowing
the misconfiguration`, plus `does not log a fault for an ordinary signed-out
request` so that line stays worth reading when it appears.

Checks, in three layers because no one layer reaches the whole claim:
- `clerk-mounting.spec.ts` (6 tests) pins the bootstrap decision, which no e2e
  can reach — `bootstrap()` runs at import time and binds a port. The
  regression case is named: `does not mount Clerk with no key even when the dev
  bypass is off`. Its opposite is pinned too (`mounts Clerk with a real key
  even while the dev bypass is armed`), so the fix cannot be misread as "the
  bypass turns Clerk off".
- `clerk-auth.guard.spec.ts` for the 401, the log, and the silence.
- `Auth wiring with no Clerk keys (e2e)` in `test/auth.e2e-spec.ts` assembles
  the app the way `shouldMountClerk() === false` says to — no middleware,
  bypass disarmed — and asserts 401 on `/tasks`, `/me`, `/me/stats`,
  `/ingestion`, `/health` not 500, and the operator-facing log line. Its
  `beforeAll` asserts `shouldMountClerk()` is false rather than assuming it, so
  the block cannot drift into standing in for a server the bootstrap would
  never produce.

Mutation runs (each restored byte-identical, sha256 checked). Baseline is unit
154 passed / 2 skipped (156) and e2e 132 passed across 6 files:
- Guard's catch narrowed back to the armed-bypass case: unit 2 failed / 152
  passed (`answers 401, not 500, when the Clerk context cannot be read at all`,
  `says so loudly in the log…`), e2e 3 failed / 129 passed (`answers 401, not
  500, on a guarded route`, `answers 401 on every guarded route…`, `tells the
  operator why…`). Nothing else moved.
- **That mutation caught a weak assertion of mine on the first pass.** `tells
  the operator why` originally looked for the substring `clerkMiddleware()` in
  the logged messages — and *passed* under the mutation, because Nest logs the
  stack of the unhandled error too, and that stack also says `clerkMiddleware`.
  It now asserts the guard's own wording (`treating the request as
  unauthenticated`) and fails under the mutation as it should. A log assertion
  that also matches the crash it exists to rule out is the fence incident in
  miniature.
- Mount rule reverted to `keyLooksUsable() || !devBypassArmed()`: unit 3 failed
  / 151 passed (`does not mount Clerk when the key is absent`, `…on the
  placeholder from .env.example`, `…with no key even when the dev bypass is
  off`). The e2e side is worth reading carefully: the premise assertion fails
  in `beforeAll`, so vitest reports **`Test Files 1 failed | 5 passed`, but
  `Tests 127 passed | 5 skipped (132)` — zero failed**. The five tests are
  *skipped*, not failed, and only the file-level line and the non-zero exit say
  otherwise. A `beforeAll` failure always reports this way; anyone reading a CI
  summary for the word "failed" on the Tests line would miss it.

**One claim here is evidence, not a check, and is marked as such.** "Clerk with
no key 500s every route" was verified directly against `@clerk/express` in a
clean process — the middleware calls `next(err)` with "Publishable key is
missing" — but it cannot be pinned by a test in this suite. `@clerk/express`
caches its client the first time one is built successfully, process-wide, and
e2e files share a process (`fileParallelism: false`): the earlier suites build
one with placeholder keys, so a later `clerkMiddleware()` constructed with the
keys deleted goes on serving requests happily. It was asserted at 500 and came
back 200, which is how this was found. Reproduced outside vitest both ways —
one middleware with keys then a second without, same process, both pass; a
fresh process with no keys ever set, every request rejected. Anything that
needs to observe a misconfigured Clerk must spawn a clean process. The comment
at the foot of `test/auth.e2e-spec.ts`, where that suite would have gone,
records this so the next person does not write the test and watch it pass for
the wrong reason.

Also checked while here, and *not* a bug: Clerk reads the publishable key when
the middleware is **constructed**, not when the module is imported. That
matters because `main.ts` imports `@clerk/express` at the top, above its
`process.loadEnvFile()` call — if the key were captured at import time, a
correctly configured `.env` would still produce a keyless Clerk. Probed both
orders in fresh processes; both pass.

**The real Clerk session path on mobile is Phase 2, and the live-tenant smoke
test gates any real device ship.** In the scope ledger in
`docs/adhd_tracker.md` as two rows, not one, because they are separate pieces
of work and one blocks the other:
- *Real Clerk sessions on mobile.* The web client runs the genuine path; the
  Expo shell does not. A phone has no cookie jar, so it needs a bearer token
  from Clerk's React Native SDK — a new dependency, a refresh story, and secure
  storage on the device. The seam is already cut and named:
  **`setAuthTokenProvider` in `apps/mobile/src/lib/api-client.ts`**. Wiring a
  provider into an existing hole, not a redesign.
- *Live-tenant auth smoke test.* Nothing in this repo has ever verified that a
  **genuine** Clerk token is *accepted* — every check is a rejection check, and
  deliberately hermetic so CI needs no tenant and no egress (`reached no
  external network at all`). Accepting one needs real keys against a live
  instance, i.e. a smoke test against a deployed environment, which is
  deployment work this phase has not done. **This is the gate on shipping to a
  real device:** until it exists, mobile sign-in is `DEV_AUTH_BYPASS` only, and
  a build handed to anyone but the developer would have no working way in.
  Claiming "mobile auth works" before that check exists is exactly the claim
  the last rule in this file forbids.

## Phase 1.5 — Milestone D, part 2 (push notifications) ✅

Expo push tokens stored per user, and two server-side triggers on an hourly
BullMQ sweep: a due-date reminder for anything due today and unfinished, and a
streak nudge when nothing has been completed today and the run is worth
protecting. Migration
`20260909081634_add_push_tokens_and_notification_dispatches`.

**`PUSH_SENDER` is a port, same shape as `TRANSCRIBER`/`EXTRACTOR` — a `Symbol`
token, a hand-rolled `fetch` adapter, no vendor SDK.** `ExpoPushSender` is the
only file in the repo that may name `exp.host`, the same rule `src/ai/` carries
for OpenAI. `test/fakes/push.fakes.ts` supplies `FakePushSender` at that
boundary and the whole e2e suite runs with no network.

**The port carries *why* a message failed, not just that it did.** `PushReceipt`
is `{ token, ok, reason?, detail? }` with `reason` one of
`device_not_registered | message_too_big | message_rate_exceeded |
invalid_credentials | transport | unknown`, because token cleanup is a
destructive act and needs the reason before it is allowed to happen. **Only
`device_not_registered` deletes anything.** Every other reason describes a bad
moment, not a dead device, and registration only happens on the phone at app
start — so an unsubscribed user would not find out until they next opened the
app, if ever. Checks: an `it.each` over all five other reasons (`deletes
nothing on a %s failure`), `deletes only the dead device out of a mixed batch`,
and end-to-end `keeps a perfectly good registration through a transient
failure`.

- The receipt carries the **token**, not a position. Expo correlates tickets
  positionally and offers nothing else, so a short `data` array means we cannot
  say which device each ticket is about — that becomes `unknown` for the whole
  batch rather than a guess. Check: `refuses to guess when the ticket count
  does not match the batch`. Lining them up anyway deletes the wrong person's
  registration.
- An unrecognised error code is `unknown`, never a deletion, so Expo cannot
  unsubscribe our users by adding a code. Check: `calls an error code it has
  never seen unknown, and deletes nothing`.
- A 401/403 is `invalid_credentials` for every message in the batch, not a
  device problem. The failure mode ruled out: our own auth error looking like
  the entire estate deregistering at once. Check: `blames our credentials, not
  the devices, when Expo refuses the whole request`.
- **`PushSender.send` never throws** — a dead push channel is an ordinary
  Tuesday and must not take out the sweep. Network throws, timeouts
  (`AbortSignal.timeout`, `PUSH_SEND_TIMEOUT_MS`) and unreadable JSON all become
  `transport` receipts. The service wraps the call in a try/catch anyway, and
  that belt-and-braces is itself pinned: `does not leave the row on claimed when
  the sender breaks its contract` and e2e `survives a sender that breaks its
  contract and throws`.

**Idempotency is the database's, not the scheduler's: claim before send.**
`notification_dispatches` has `@@unique([userId, dedupeKey])`; `dispatch()`
writes the row *first*, and a `P2002` on that insert means somebody already sent
it, so this sweep sends nothing and counts it `alreadySent`. Send-then-record
would double-send on any crash between the two and — far more commonly — on the
next hourly tick, because the conditions are all still true.

- `dedupeKeyFor(kind, calendarDate, taskId?)` builds **one non-null string**
  (`streak_nudge:2026-09-09`, `due_reminder:2026-09-09:task-7`), never a tuple
  with a nullable member. Postgres treats NULLs as distinct in a unique index,
  so a null `taskId` would make every nudge unique and the constraint would
  prevent exactly nothing. Check: `identifies a streak nudge by kind and day,
  because there is no task`.
- The calendar date is the **user's**, from `users.timezone`, same rule as
  streaks. Checks: `reads the window on the user's clock, not the server's`
  (Auckland), and the unit assertion that London's day starts at
  `2026-09-08T23:00:00.000Z`.
- Rider 2's named case is pinned directly: *"no completion today" stays true all
  day*, so a naive nudge fires on every one of the twelve in-window ticks.
  `nudges once a day however many times the day is swept` sweeps repeatedly and
  requires exactly one push; `nudges again the following day, because that is a
  different day` stops that collapsing into "never nudge twice".
- A failed send still holds its claim for the rest of the day, with the reason
  on the row: `does not retry a failed send later the same day, and the row says
  why`. Retrying an unreachable device hourly is how a bad afternoon becomes
  twelve notifications at teatime.

**The nudge requires `lastActiveDate === yesterday`, not just `currentStreak >=
3`.** `currentStreak` is not recomputed until the next completion, so a run
abandoned a week ago still reads `12` — nudging about it would be telling the
user to protect something that is already gone. Checks: `does not nudge about a
run that is already broken`, the e2e pair `stays quiet below the threshold,
where there is nothing worth protecting` and `stays quiet once they have
finished something today`, and a unit `it.each` over four non-cases.

**The draft fence holds here too.** The due-reminder query carries
`NOT: { source: 'ai_suggested', confirmedAt: null }` — the pair, so an approved
suggestion is still reminded about. Pinned in both directions: `never mentions
an unconfirmed AI draft — the fence holds here too` and `does mention a
suggestion once the user has approved it`. Notifying someone about a task the
AI invented and they never confirmed is the fence failing on the one surface
that interrupts them.

**Two product decisions that were not in the brief, made here and flagged:**
- `DUE_REMINDER_MAX_PER_SWEEP = 5`. A user with thirty tasks due today does not
  need thirty pushes — that is the app becoming the noise it exists to reduce.
  The overflow *rolls forward* to the next sweep rather than being dropped,
  because an unclaimed task is still unclaimed. Check: `sends at most a handful
  at once, and picks the rest up next time`.
- A 09:00–21:00 local notify window (`REMINDER_WINDOW_START_HOUR` /
  `REMINDER_WINDOW_END_HOUR`). An hourly cron with no window delivers the day's
  first reminder at 00:00 local. Checks: `does not push at three in the
  morning`, and the Auckland test above. Nothing is *claimed* outside the window
  either, so registering a phone at lunchtime still gets the day's reminder —
  check: `registers late and still gets the reminder the same day`.

**Registration is an upsert on the token, not on `(userId, token)`.** A phone
wiped and handed on keeps its Expo token, and the new owner's registration must
*move* it. The alternative leaves the previous owner's reminders arriving on a
stranger's lock screen with every send succeeding, so nothing in the system
would ever notice. `pruneDeadTokens` is scoped to the user the sweep was sending
for, which closes the same race from the other side. Checks: `upserts on the
token, so a handed-on phone moves rather than duplicating`, `scopes the delete
to the user the sweep was sending for`, and end-to-end `moves a handed-on device
to its new owner rather than duplicating it` and `is idempotent — an app that
registers on every launch keeps one row`.

**Routes:** `GET`/`POST`/`DELETE /me/push-tokens` behind `ClerkAuthGuard`.
`POST` answers **200, not 201** — the common call is an app registering on cold
start and changing nothing. `DELETE` takes the token in the **body**, because
Expo tokens contain square brackets and a path segment is the wrong place for
them. Deregistering someone else's token is silent rather than 404: there is no
useful difference between "already gone" and "never yours", and 404 would
confirm the token exists. The token format is validated by a custom
`IsExpoPushToken` decorator delegating to the shared `isExpoPushToken`, so the
rule is stated once.

**Worker/processor split, same as ingestion.** `runSweep(now)` is a plain method,
so every test drives the whole trigger with no Redis; `ReminderWorker` owns the
BullMQ queue and `upsertJobScheduler` with a fixed scheduler id.
`REMINDER_WORKER_DISABLED=true` (set by `test/load-env.ts`, declared in
`turbo.json` for `dev`/`test`/`test:e2e`) stops the consumer subscribing. BullMQ
rather than `@nestjs/schedule` because an in-process timer fires once *per API
instance* — two instances, two notifications, with the unique index as the only
thing between the user and a duplicate.

One user's failure never silences the users behind them: `runSweep` try/catches
per user. Check: `carries on after one user fails, so nobody behind them is
silenced`.

Mutation runs (each restored byte-identical, sha256 checked). Baseline is unit
218 passed / 2 skipped (220) across 15 files and e2e 162 passed across 7 files:
- Unique index `notification_dispatches_user_id_dedupe_key_key` dropped in
  Postgres: e2e 4 failed / 158 passed — `does not send twice when the same day
  is swept again`, `sends at most a handful at once, and picks the rest up next
  time`, `nudges once a day however many times the day is swept`, `does not
  retry a failed send later the same day, and the row says why`. The nudge
  assertion read `expected [ … ] to have a length of 1 but got 6` — six
  in-window sweeps, six pushes, which is exactly the failure rider 2 named.
- `dispatch()` reordered to send before claiming: the same four e2e tests, 4
  failed / 158 passed. Two independent mutations, one failure set — the claim
  and the constraint are one mechanism, and neither half works alone.
- `pruneDeadTokens`' reason filter widened to `!receipt.ok` (delete on *any*
  failure): unit 6 failed / 212 passed — all five `deletes nothing on a %s
  failure` cases plus `deletes only the dead device out of a mixed batch`; e2e
  1 failed / 161 passed — `keeps a perfectly good registration through a
  transient failure`. Nothing else moved.
- `NOT: { source: 'ai_suggested', confirmedAt: null }` deleted from the
  due-reminder query: unit 1 failed / 217 passed (`asks only for unfinished
  tasks inside the user's own day, drafts excluded`), e2e 1 failed / 161 passed
  (`never mentions an unconfirmed AI draft — the fence holds here too`).
- Restored: `pnpm lint` 5/5, `pnpm typecheck` 5/5, `pnpm test` (shared 4, api
  218 passed / 2 skipped, web 36, mobile 10), e2e 162/162 across 7 files.

**A typecheck failure this milestone nearly shipped, worth the note.** Fixing
three `no-misused-promises` lint errors by narrowing a mock to `vi.fn<() =>
Promise<object>>()` made `mock.calls[0]` an empty tuple, so an `as [{ data: … }]`
cast in the same file became TS2352 — and `pnpm lint` was re-run while `pnpm
typecheck` was not. The rule in this file is `pnpm lint && pnpm test`; typecheck
is a third gate, and a lint fix that changes a type annotation is exactly the
change that moves it. The mock now carries its argument type (`DispatchUpdate`)
and the cast is gone.

**What no test here reaches.** No push notification has ever been delivered to a
real device: `ExpoPushSender` has never been pointed at `exp.host` — there is no
Expo project id, no real device token, and no integration spec equivalent to
`openai.integration.spec.ts`. Everything above is a claim about our side of the
boundary: the request we build, the meaning we assign to each answer, and what
we do about it. Nor is anything wired on the phone — `apps/mobile` does not ask
for notification permission and never calls `POST /me/push-tokens`, so no token
can reach the table except by hand. Both belong with the live-tenant smoke test
in the deployment work, and **"push notifications work" is not a claim being
made** until they exist.

## Phase 1 closure — acceptance and open items

**Browser acceptance (performed, milestone C+D):** API, web, Postgres, Redis,
MinIO running locally via docker compose; dashboard verified on
localhost:3000 — gamification header rendering real data, task add/complete,
AI draft suggestion visible behind the include=drafts toggle, dev sign-in
banner rendering its own auth state. LAN-origin viewing
(100.120.169.53:3000) blocked by Next dev origin rules + the API's CORS
allowlist; accepted as dev-only — localhost is the supported dev origin.

**Outstanding, not blocking Phase 2 planning:**
- ~~Mobile shell has never been booted~~ — booted under Metro (Expo web) and
  exercised in a browser on 2026-10-07 (voice-notes sections below). Only
  *device* acceptance remains, and it is checklist item 5.
- **CI on 14217b6 — resolved, it was a flake.** Run 34337559296 attempt 1
  failed the verify job on one mobile test (`home-screen.test.tsx`, `asks for
  drafts…`: `Exceeded timeout of 5000 ms`); attempt 2 passed unchanged, and
  `main` has been green since. Cause: the first test in a file pays for a cold
  React Native transform. `apps/mobile/jest.config.js` now sets
  `testTimeout: 20_000`. Read the failing step before calling CI broken —
  `gh` lives at `C:\Program Files\GitHub CLI\gh.exe`, not on PATH.

**Post-closure fix — two ingestion races (review, 2026-10-07).** The
processor's up-front status read is a snapshot a 60 s provider call can
outlive. (1) An erase landing mid-transcription was undone — transcript
written back, drafts created. (2) Overlapping deliveries of one job both
passed the terminal guard and doubled the drafts; the existing idempotency
test is sequential and could not see it. Every write after the first read is
now a conditional `updateMany` on `STILL_OPEN` (`deletedAt: null`, status not
terminal), and the final step claims `draft_created` *first* in an
interactive transaction, so the row lock serialises the copies. Checks:
`does not double the drafts when two deliveries of one job overlap`, `stays
erased when the delete lands while the memo is being transcribed`, `never
processes a memo erased while its job was still waiting` (e2e), plus five
unit tests. Mutations: processor reverted to HEAD → exactly those 3 e2e fail;
`STILL_OPEN` dropped from the final claim only → 1 e2e + 2 unit fail.
Restored sha256-identical; e2e 165/165, all four gates green with `--force`.

**XP is paid at most once per task per day (2026-10-07, product ruling).**
Complete → reopen → complete used to pay every time (it was pinned as
intended). Ruling: an identical task pays once; the same task done again on a
later day — a daily habit — pays again. `xp_events.award_key`
(`task_complete:<taskId>:<user's local date>`) with `@@unique([userId,
awardKey])`, inserted via `createMany({ skipDuplicates: true })` — `ON
CONFLICT DO NOTHING`, because a raised unique violation would abort the
transaction and roll the completion back with it. Migration
`20261007120000_xp_award_once_per_task_per_day`. Checks: `pays once a day
however many times a task is reopened and completed` (also asserts the task
still lands `done`), `pays again when the same task is done again on a later
day`, plus two unit tests on the key. Mutations: key removed → 1 e2e + 6 unit
fail; `skipDuplicates` removed → the same e2e fails (the second completion
500s) + 4 unit. Restored sha256-identical. Open question: two *separate* tasks
with the same title still pay separately — "identical" is per task row.

**Mobile toolchain realigned to Expo SDK 57 (2026-10-07).** `npx expo install
--check` is the authority: SDK 57 targets React Native **0.86** and jest-expo 57
requires Jest 29 (`@react-native/jest-preset ^0.86.3`), so the 0.87/Jest 30 noted
in Milestone C were off-SDK. `react`/`react-dom` pinned to 19.2.3,
`react-native-web` added for `expo start --web`, and `.npmrc` hoists
`*expo*`/`*react-native*` for Metro under pnpm.

**Object storage is SeaweedFS, not MinIO (2026-10-07).** MinIO stopped
publishing images — `minio/minio` on Docker Hub ("repository does not exist")
and quay.io (401) both refuse pulls — so CI's e2e job could not start on a
fresh runner; local only worked off a cached image. `docker-compose.yml`
service `storage` (container `adhd-storage`) and the CI "Start object storage"
step run `chrislusf/seaweedfs:4.48` `server -s3`, gateway on container 8333
published at host **9000**, so `MINIO_ENDPOINT` and every `MINIO_*` name are
unchanged. No console. Health = an unsigned request answering 403. Checked:
e2e 166/166 twice against it, then again through the compose service with the
stock `.env`. Older text above saying "MinIO" now means "object storage"; the
old `minio_data` volume is orphaned and safe to `docker volume rm`.

**Never run e2e with `pnpm dev:api` up.** The dev API's ingestion worker shares
Redis with the suite and drains the test's `audio-ingestion` jobs — with its
own storage endpoint — so records land on `failed` before the test's
`processor.process()` runs. It looks exactly like a storage bug (16 pipeline
tests fail, differently each run). `nest start --watch` restarts a killed
child, so stop the watcher too: check `Get-CimInstance Win32_Process` for
`dist\main`, not just the listening ports.

**Voice notes: "Upload failed" fixed, in-app recording added (2026-10-07).**
Cause: on Expo **web**, `uploadVoiceMemo` handed the browser's `FormData` the
React Native `{uri,name,type}` object, which throws `TypeError: parameter 2 is
not of type 'Blob'` before any request exists — so it was never an `ApiError`
and the screen said only "Upload failed". Reproduced in the running app; the
same request with a real `Blob` was a 202. `apps/mobile/src/lib/audio-part.ts`
(`toUploadPart`) now gives native the object and web a real Blob (the picker's
`File`, or the recording's `blob:` URL fetched back). Kept out of
`api-client.ts`, which must stay React-Native-free for the API e2e. Non-API
errors now show their message (`uploadErrorMessage`), never a bare "Upload
failed". Check: `audio-part.test.ts`; mutation (always send the object) → 3 of
its web tests fail — one only after tightening it, since the object also has
`type: 'audio/webm'` and a type-only assertion passed against the bug.

`VoiceRecorder` (expo-audio ~57.0.5 — new dependency, added on the user's
request for in-app recording; `microphonePermission` text in `app.json`):
permission → record → **stop is send**, no review step, because the human
check is the draft approval that already exists. m4a on phones, webm on web;
the type is read from the URI. Under Jest, `expo-audio` is native and cannot
load, so `moduleNameMapper` points it at `test/expo-audio-fake.ts`.

`OpenAiTranscriber` now names the file for Whisper from its content type
(`whisperFileName`: `audio/mp4` → `memo.m4a`, …) instead of always
`memo.webm`. Hardening, **not** the cause: a mislabelled WAV transcribed fine
against the real Whisper, so the old name was not proved to break anything.

Verified live (Expo web, real API, SeaweedFS, real Whisper/GPT-4o): a recorded
note → 202 → `draft_created`; a picked WAV → 202 (was "Upload failed"); a
synthesised spoken memo → transcript verbatim → two unconfirmed drafts with due
dates, shown under Suggestions with Done disabled. Not verified: recording on a
physical phone (no device here); the browser test fed `getUserMedia` a
synthetic tone, since the harness cannot grant a mic prompt.

**Voice notes report what happened (2026-10-07, user report).** The user saw
"Queued — uploaded" and then nothing. The pipeline had worked — their note
("Go to the shop and get some food.") made a draft — but the 202 comes back
before the worker transcribes, the list refreshed only at that moment, and
nothing refreshed afterwards, so the suggestion was invisible until a manual
reload; a silent note ("you") gave no feedback at all. `followMemo`
(`apps/mobile/src/lib/memo-progress.ts`) now polls `GET /ingestion/:id`
(1.5 s, 90 s cap) and both buttons end on what was heard and how many
suggestions it made, then refresh. Checks: `memo-progress.test.ts` (6), and
the recorder test asserting the final message and a second refresh. Mutation
(skip the wait) → exactly that recorder test fails. Verified live: an upload
and a recording each ended on the "Heard …" line with Suggestions updated, no
reload.

Two things found on the way, not fixed: **Metro did not pick up edits** to an
already-running `expo start` here — the page served the old bundle until a
restart with `--clear`; check `curl` of the bundle for new strings before
trusting a browser check. And **extraction is not deterministic despite
`temperature: 0`**: the identical transcript "Reminder to self. Pay the
electricity bill this week." made 0 drafts at 18:19:50 and 1 at 18:22:03. The
user now *sees* a 0 rather than silence, but under-extraction on a clear
commitment is a quality issue for the extractor prompt — Phase 2 candidate.

**Suggestions are approved on the phone: "Add to tasks" (2026-10-07, user
report).** The Done buttons under Suggestions could not be pressed — by design,
since `done` on an unconfirmed draft is a 409, but the only way forward was
"approve them on the web app", which a phone user cannot act on. A draft row
now shows **Add to tasks**, which calls the new mobile `approveTask`
(`POST /tasks/:id/approve`, same route as web); the task moves to Tasks with an
ordinary Done, and the server pays the 1 review XP. No reject on mobile yet.
Checks: `task-list.test.tsx` (a draft has an approve button and no complete
button; pressing it calls onApprove, never onComplete), `home-screen.test.tsx`
(approve route, then reload), and in the API e2e `adds a suggestion to the
phone's tasks through the approve route` (409 before, approve, then Done works)
— the contract proof, since the UI tests mock the client. Mutation (draft
button calls onComplete) → 2 mobile tests fail. Verified live: approve 200,
XP 20→21, then Done, XP 21→31.

**Starter badges — Phase 1 closed (2026-10-08).** `user_badges` (migration
`20261008090000_add_user_badges`): one row per `(user_id, badge_key)`, the
unique index is the once-only rule, and awards use `createMany({
skipDuplicates: true })` inside the transaction that earns them — the same
mechanism and reasoning as the XP `award_key`. Keys are text, defined in
`packages/shared/src/badges.ts` (`BADGE_KEYS`/`BADGES`), so a new badge needs no
migration. Three, as the planner suggested and the owner left standing:
`first_task_done` "First win" (any completion), `streak_3` "On a roll" (the
streak update reaches `STREAK_BADGE_DAYS = 3`), `first_suggestion_reviewed`
"Second opinion" (approve *or* reject — same as the review XP). Not an XP event
type and worth no XP. `GET /me/badges` (its own route, so the `/me/stats`
contract is unchanged); shown under the stats header on web and mobile.
Checks (e2e, real Postgres): `awards "First win" once, however many tasks are
finished` (also asserts every completion still answers 200), `does not keep a
badge from a completion that rolled back`, `awards "On a roll" on the third day
of a run, and not before`, `awards "Second opinion" for rejecting a
suggestion…`, `never shows one user another user's badges`, and in
`mobile-client.e2e-spec.ts` `reads the badges a completion earned…`. Plus 3
unit and a UI test each on web and mobile. Mutations (restored sha256-identical):
- plain insert instead of `skipDuplicates` → the First-win test + 4 XP tests
  fail. **The First-win test passed this mutation on the first pass**: it
  checked only the badge list, which stays correct while the second completion
  500s and rolls back. It now asserts each completion's 200.
- badge written via `this.prisma` instead of `tx` → only the rollback test.
- threshold `>= STREAK_BADGE_DAYS - 1` → only the On-a-roll test.
Green: all four gates with `--force` (shared 4, api 239 / 2 skipped, web 37,
mobile 39), e2e 173/173.

**Real Clerk sign-in on mobile; checklist item 1 proved locally (2026-10-08).**
- `@clerk/expo` 4.8.1, **not** `@clerk/clerk-expo` — the latter is deprecated
  (Core 3 rename). `expo-secure-store` ~57.0.4 for the token cache (native
  only; Expo web uses Clerk's own browser storage). Both via `npx expo install`.
  pnpm then refused `browser-tabs-lock` / `core-js` install scripts as
  `ERR_PNPM_IGNORED_BUILDS` — an *error* under this pnpm, so CI's frozen
  install would have failed too; both are set `false` in pnpm-workspace.yaml
  with the reason.
- `src/auth/clerk-session.tsx`: `ClerkRoot` wraps the app when
  `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` is set and passes through otherwise;
  `ClerkTokenBridge` feeds `getToken()` into `setAuthTokenProvider`, which is
  now async-capable. `SignInScreen` uses the Core 3 signal API (`signIn.create`
  → `finalize`; `emailCode.sendCode/verifyCode`; `mfa.sendEmailCode` for
  `needs_client_trust`/`needs_second_factor`). The instance signs in by email +
  password or email code (read from its `/v1/environment`); accounts are made
  on the hosted sign-up page.
- **A real token replaces the dev header, never accompanies it**
  (`authHeaders`). The guard checks `x-dev-user` first, so sending both would
  sign the request in as the dev user and make a real sign-in unprovable. And
  with a Clerk key configured the gate requires a session — dev mode is not a
  fallback. Checks: `sign-in-screen.test.tsx` (9, against
  `test/clerk-expo-fake.tsx` via `moduleNameMapper`). Mutation (send both
  headers) → exactly `sends only the bearer token…` fails.
- `test/load-env.ts` now deletes `CLERK_PUBLISHABLE_KEY`/`CLERK_SECRET_KEY`,
  same as `OPENAI_API_KEY`: a developer .env with real keys must not change
  what the hermetic e2e suites see. E2e 173/173 with real keys present.
- **Checklist item 1 — a genuine token ACCEPTED — proved against the local
  API, not a deployed one.** `src/auth/clerk-live.integration.spec.ts`
  (opt-in: `CLERK_LIVE_SMOKE=1` *and* an `sk_test_` key, so never in `pnpm
  test`/CI and never against production) creates a throwaway Clerk user, mints
  a real session token, and GETs `/me` through the real `clerkMiddleware()` and
  unmocked guard with `DEV_AUTH_BYPASS` deleted: **200** and that Clerk user
  provisioned; a tampered token **401**; user deleted after. Skips with no
  network by default. The deployed half waits for a deploy target.
- Android bundle builds with Clerk in it (`expo export --platform android`,
  748 modules). **Not yet verified: a sign-in on the physical phone** — that is
  checklist items 2 + 5, and needs the PC's firewall to admit the phone.

**Deployment checklist — the gate on any real device ship, consolidated
here (details in the milestone sections above):**
1. Live-tenant Clerk smoke test — a *genuine* token ACCEPTED (all existing
   checks are rejection checks). Blocks everything.
2. Real Clerk sessions on mobile — `setAuthTokenProvider` in
   `apps/mobile/src/lib/api-client.ts` is the cut seam; needs Clerk's RN SDK,
   refresh story, secure storage.
3. Real push delivery — Expo project id, real device tokens, an integration
   spec equivalent to `openai.integration.spec.ts`; `ExpoPushSender` has
   never pointed at exp.host.
4. Mobile client-side registration — notification permission request +
   `POST /me/push-tokens` call on the phone; nothing populates the table
   except by hand today.
5. Device acceptance on a physical phone (Metro boot and browser acceptance
   are done). Includes in-app recording, which has only run in a browser.
6. ~~Starter badges~~ — shipped 2026-10-08, see below.

**Milestone 3 dependencies, approved 2026-10-08** (add each with `npx expo
install` so the version matches SDK 57; record the resolved versions here):
`@clerk/clerk-expo` (real mobile sessions through `setAuthTokenProvider`),
`expo-secure-store` (token cache — no web implementation, so Expo web needs a
fallback), `expo-notifications` + `expo-device` (push registration; skip on
web), and EAS development builds (Expo Go cannot do remote push). Credentials
these need: a Clerk instance's keys, an Expo account + EAS project id, FCM v1
credentials for Android, an Apple Developer account for iOS. The
architect-proposed additions (Sentry, pino, a deploy target, Maestro) are *not*
approved yet — see docs/adhd_tracker.md.

Items 1–4 need real credentials/decisions from the human BEFORE their
milestone starts (Clerk live tenant keys, Expo account + project id, a
physical device). Flag them early so nothing stalls mid-milestone.

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
- Run `pnpm lint && pnpm typecheck && pnpm test` as ONE set before declaring
  any task done — no judgment about which gates a change "affects". A lint
  fix that touches a type annotation is a typechange (Milestone D nearly
  shipped one), and CI checks a fourth thing (build) besides.
- Every "done" claim in the progress section must map to a check that would
  fail if the thing were missing. No check = not done = don't claim it.

## Commands
- `docker compose up -d` — PostgreSQL (host port 5434), Redis, and SeaweedFS S3 (host port 9000) for local dev
- `pnpm dev:api` — run API locally (needs the compose services up)
- `pnpm test` — unit tests (no infrastructure required)
- `pnpm test:e2e` — API e2e suite; needs the compose services up
- `pnpm db:migrate` — Prisma migrations
- `pnpm --filter @adhd/api db:generate` — regenerate the Prisma client after a
  schema change (a stale client fails at runtime, not at typecheck)
- `pnpm dev:api` serves on 3001; `pnpm --filter @adhd/web dev` on 3000;
   `pnpm --filter @adhd/mobile start` (press `w` for web, port 8081)
- Stale node processes hold 3000/3001/8081 after terminals close —
  `Get-NetTCPConnection -LocalPort 3000,3001,8081 -State Listen` is the
  pre-flight; EADDRINUSE on any of them means last session's zombie
- Dev viewing origin is localhost only (LAN IP blocked by Next dev origin
  rules + CORS allowlist — see closure section)
- `pnpm lint -- --force` / `--force` on any turbo task bypasses cache —
  use it when a cached green result needs to be trusted
