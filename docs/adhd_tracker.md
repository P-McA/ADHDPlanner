# Gamified AI-Driven Task Tracker — Architecture & Roadmap

---

## Prerequisites

- Node.js 24.19.0 (see `.nvmrc`)
- pnpm 12.3.4

---

## 1. Optimal Tech Stack

### Frontend

| Component | Recommendation | Rationale |
|---|---|---|
| **Mobile (primary)** | React Native (Expo) | Single codebase for iOS/Android; Expo simplifies push notifications; shares TypeScript types with web |
| **Web/Desktop/Tablet** | Next.js (React 18) | SSR, PWA support, excellent tablet panel layouts |
| **State** | TanStack Query + Zustand | Server-state sync (tasks) vs. local state |
| **UI Kit** | Tailwind + shadcn/ui (web), NativeWind (mobile) | Consistent design tokens across platforms |
| **Offline-first** | WatermelonDB (mobile) / IndexedDB (web) + sync engine | Tasks must work without connection; sync on reconnect |

### Backend

| Component | Recommendation | Rationale |
|---|---|---|
| **API Gateway** | Node.js (NestJS) or Go | NestJS fits if team is TS-heavy; Go if performance-focused |
| **Architecture** | Modular monolith → extract microservices later | Don't over-engineer at MVP; keep AI services separate from day one (they have different scaling profiles) |
| **Realtime/WebSockets** | Socket.IO or NATS | Cross-device sync, live status prompts |
| **Push** | FCM + APNs via unified service (e.g., OneSignal or raw) | Cross-platform prompts |
| **Auth** | Auth.js / Clerk / Firebase Auth (OIDC) | Don't build auth yourself |

### Database

| Store | Purpose |
|---|---|
| **PostgreSQL (+ pgvector)** | Core data: users, tasks, gamification, embeddings for semantic task search/suggestions |
| **Redis** | Sessions, rate limiting, XP leaderboards (sorted sets), job queue |
| **Object Storage (S3/R2)** | Voice notes, images, whiteboard photos |
| **ClickHouse (Phase 3)** | Analytics on user behavior for personalization (add later) |

### AI/ML Stack

| Capability | Tool | Notes |
|---|---|---|
| **Voice → text** | OpenAI Whisper (self-host via faster-whisper) or Deepgram API | Deepgram = lower latency managed option |
| **Vision (handwriting/whiteboard)** | GPT-4o / Claude 3.5 Sonnet | Best handwriting OCR + task extraction in one shot |
| **LLM (task breakdown, LOE, suggestions)** | Claude Sonnet / GPT-4o behind a router | Use **LiteLLM** as an abstraction layer so you can swap models without refactoring |
| **Agents** | LangGraph (preferred over plain LangChain for stateful, resumable agent runs) | Human-in-the-loop checkpoints are critical |
| **Orchestration/Queue** | Temporal or Celery/BullMQ | Long-running agent jobs need durable execution |
| **Embeddings** | OpenAI text-embedding-3-small or open-source (BGE) | Semantic dedup + related-task suggestions |
| **Tools for agents** | Model Context Protocol (MCP) + function calling (calendar, email via Gmail/Outlook APIs, research via search API like Tavily) | Booking meetings = Google Calendar API + availability check |

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────┐
│                    CLIENTS                          │
│   iOS/Android (RN)      Web (Next.js PWA)           │
│        │  push (FCM/APNs)    │  WebSocket           │
└────────┼──────────────────────┼────────────────────┘
         ▼                      ▼
┌─────────────────────────────────────────────────────┐
│              API GATEWAY (NestJS)                   │
│  REST/gRPC for CRUD · WebSocket for sync · Auth     │
└──────┬───────────────┬──────────────────┬───────────┘
       │               │                  │
       ▼               ▼                  ▼
┌─────────────┐ ┌──────────────┐ ┌───────────────────┐
│ CORE SVC    │ │ GAMIFICATION │ │ SYNC SVC          │
│ users/tasks │ │ XP/streaks/  │ │ cross-device      │
│ priorities  │ │ badges/quests│ │ state + prompts   │
└──────┬──────┘ └──────┬───────┘ └───────────────────┘
       │               │
       ▼               ▼
┌─────────────────────────────────────┐
│  EVENT BUS (NATS/Redis Streams)     │
│  "task.created", "task.completed"   │
└──────┬──────────────────────────────┘
       ▼
┌─────────────────────────────────────────────────────┐
│            AI SERVICE CLUSTER (separate deploy)     │
│  FastAPI + LiteLLM                                  │
│  ├─ Ingestion Pipeline: Whisper / GPT-4o vision →   │
│  │   structured task extraction → draft review      │
│  ├─ Task Intelligence: LOE estimation, breakdown,   │
│  │   dynamic priority scoring, predictive generation│
│  └─ Agent Runtime (LangGraph + Temporal):           │
│      email drafting, scheduling, research           │
└──────┬──────────────────────────────────────────────┘
       ▼
┌─────────────────────────────────────────────────────┐
│  PostgreSQL (pgvector) · Redis · S3 · Temporal      │
└─────────────────────────────────────────────────────┘
```

### Key Flows

- **Multimodal ingest:** Client uploads media to S3 → publishes event → AI service transcribes/OCRs → extracts tasks → **saves as drafts for user confirmation** (never auto-create — trust matters) → user approves → core service creates tasks → gamification service awards XP for capture.
- **Task completion:** Core service emits `task.completed` → gamification consumes → updates XP/streak → push service sends reward notification to all devices via sync service.
- **Agents:** Core service calls agent orchestrator → Temporal workflow runs with checkpoints → pauses for approval on side-effecting actions (sending email, booking) → user approves via push notification deep-link.

---

## 3. Core Data Model (PostgreSQL)

```sql
users (
  id UUID PK, email, name, auth_provider, avatar_url,
  timezone, preferences JSONB, created_at
)

tasks (
  id UUID PK, user_id FK→users,
  title TEXT, description TEXT,
  status ENUM(pending, in_progress, done, archived),
  priority_score FLOAT,          -- computed by dynamic prioritization
  manual_priority ENUM(low, med, high, urgent),
  due_at TIMESTAMPTZ,
  loe_minutes INT,               -- AI-estimated effort
  loe_confidence FLOAT,
  parent_task_id FK→tasks NULL,  -- LLM-generated subtasks
  source ENUM(manual, voice, image, agent, ai_suggested),
  completed_at, created_at, updated_at
)

task_steps (                    -- LLM step-by-step guidance
  id UUID PK, task_id FK→tasks, sequence INT,
  description TEXT, is_completed BOOL
)

task_dependencies (
  task_id FK→tasks, depends_on FK→tasks, PK(task_id, depends_on)
)

media_inputs (
  id UUID PK, user_id, type ENUM(voice, image),
  s3_url TEXT, raw_transcript TEXT,
  extracted_task_ids UUID[], processed_at
)

xp_events (
  id BIGSERIAL PK, user_id, task_id NULL,
  type ENUM(task_complete, streak_bonus, badge, quest),
  xp_amount INT, created_at
)

streaks (
  user_id PK→users, current_streak INT, longest_streak INT,
  last_active_date DATE, freeze_count INT   -- streak freezes = retention lever
)

badges ( id, name, icon, criteria JSONB )
user_badges ( user_id, badge_id, earned_at )
quests ( id, title, goal JSONB, reward_xp INT, expires_at )  -- e.g., "Complete 5 tasks this week"
user_quests ( user_id, quest_id, progress JSONB, completed_at )

agents (
  id UUID PK, user_id, task_id FK→tasks,
  type ENUM(email_draft, scheduling, research),
  state JSONB,                    -- LangGraph checkpoint
  status ENUM(pending, awaiting_approval, running, done, failed),
  action_log JSONB, created_at
)

embeddings (
  id UUID PK, task_id FK→tasks, vector VECTOR(1538)
)
```

### Key Design Decisions

- `priority_score` (float) enables smooth AI-driven reordering vs. crude enums; UI sorts by it.
- `parent_task_id` + `task_steps` = recursive task decomposition from the LLM.
- `xp_events` as an append-only ledger → prevents XP cheating and enables replay/audit.
- `agents.state` stores checkpointed agent state for resumable, auditable runs.

---

## 4. Phased Implementation Plan

### Phase 0 — Foundation (Weeks 1–3)

- Monorepo setup (Turborepo), CI/CD, IaC (Terraform), PostgreSQL + Redis + S3
- Auth, basic user profiles, API skeleton, mobile + web shells
- **Deliverable:** Deployable skeleton with auth and empty task CRUD

### Phase 1 — MVP (Weeks 4–10)

> *Goal: rock-solid task management + multimodal input + basic gamification*

1. **Task CRUD** with statuses, due dates, manual priorities; offline-first sync
2. **Core gamification:** XP for task completion, daily streaks, basic level display, 3–5 starter badges
3. **Voice input:** Record → Whisper → LLM extracts task drafts → **user confirms** → create
4. **Image input:** Whiteboard/notebook photo → GPT-4o vision → same draft-confirm flow
5. **Push notifications:** Due-date reminders, streak-protection nudges, synced read-state across devices
6. **Basic LLM task breakdown:** "Break this into steps" button (no agents, no predictive generation yet)

**Success metrics:** D7 retention > 25%, ≥ 40% of tasks created via multimodal input, streak usage > 30% of WAU.

### Phase 2 — Intelligence Layer (Weeks 11–18)

1. **Dynamic prioritization:** Priority score blending due date, LOE, dependencies, user behavior; auto-reordering UI
2. **LOE estimation** on task creation (with confidence display)
3. **Predictive task generation:** Analyze open/completed tasks + embeddings → suggest follow-up tasks ("Drafted a proposal → suggests: schedule review meeting"); user accepts/rejects (rejection data retrains prompts)
4. **Expanded gamification:** Quests, streak freezes, leaderboards (opt-in), badges tied to real behavior patterns
5. **Deep work insights:** Weekly digest of productivity patterns

### Phase 3 — Agentic Capabilities (Weeks 19–28)

1. **Agent infrastructure:** LangGraph + Temporal, MCP tool layer, audit log, approval-gated UI
2. **Agent 1 — Email drafting:** Semi-autonomous; generates, user reviews, sends via connected Gmail/Outlook
3. **Agent 2 — Scheduling:** Reads calendar availability → proposes slots → books on approval
4. **Agent 3 — Research:** Web search → summarized brief attached to task
5. **XP for agent-completed work:** Slightly reduced XP to preserve intrinsic motivation for the user's own tasks
6. **Recurring tasks & templates** (agents make these far more valuable)

### Phase 4 — Scale & Differentiation (Weeks 29+)

- Proactive "chief of staff" agent: daily planning assistant that reorganizes your day each morning
- Team/social features (shared quests, accountability partners)
- Fine-tuned personalization model on user completion patterns
- Native widget support (iOS/Android/Windows) for at-a-glance task panels
- ClickHouse analytics pipeline → adaptive gamification (tuned to individual motivation profiles)

---

## Critical Strategic Notes

1. **Human-in-the-loop is non-negotiable for MVP trust.** Every AI-extracted task and agent action should require user confirmation until confidence is proven. One bad auto-booking destroys retention.
2. **Gamification drives the AI loop.** Award XP for *providing feedback* on AI suggestions (accept/reject) — this solves your data flywheel and engagement simultaneously.
3. **Cost control:** Route simple LLM calls (breakdown) to cheaper models; reserve frontier models for vision and agentic reasoning. Cache aggressively.
4. **Biggest risk:** Gamification fatigue. Ship streaks + XP in MVP, but validate quests/social layers with real users before building leaderboards — they only work with sufficient user density.

## Scope ledger — moved out of Phase 1

Recorded in Phase 1.5 so the Phase 1 deliverable list above stays honest about
what shipped. Each of these was in the Phase 1 plan or implied by it, and each
is deferred to Phase 2 rather than dropped. None is blocked by a decision that
is still open; they are all "not now".

| Item | Origin | Deferred because |
|---|---|---|
| **Offline-first sync** | Deliverable 1 ("Task CRUD … offline-first sync") | It is a second source of truth, not a feature: WatermelonDB/IndexedDB plus a merge policy for concurrent edits, and every server-derived value (XP, level, streak day boundaries) becomes something the client must either recompute or refuse to show while offline. That is a larger body of work than the rest of Phase 1 combined, and Phase 2's realtime sync service is where the doc already puts the sync engine. |
| **Image input** | Deliverable 4 (photo → GPT-4o vision → drafts) | The whole pipeline behind it — upload, object storage, worker, extraction, draft fence — is built and provider-agnostic. Image capture is a second adapter and a second MIME allowlist against machinery that already exists, so deferring it costs a rebuild of nothing. Voice proves the flow; a second input mode adds surface without adding proof. |
| **"Break this into steps"** | Deliverable 6 | It writes subtasks, and subtasks are AI-authored task rows — the same human-in-the-loop fence, now applied to a tree rather than a list, with `parentTaskId` and cascade delete in play. The fence took three corrections on the flat case (badge drift, listing exclusion, completion guard). Applying it to decomposition deserves its own phase, not the tail of this one. |
| **Provider retry policies** | Implied by deliverable 3 | The worker deliberately never retries a failed Whisper/LLM call: the record is parked on `failed` with the error stored. Retrying a metered call that already burned its deadline needs classification (429 and 5xx yes, 400 and 401 never) and a backoff budget, and getting that wrong bills the user twice for the same memo. A wrong retry is worse than no retry. |
| **Real Clerk sessions on mobile** | Deliverable 2, as it applies to `apps/mobile` | The web client runs the genuine Clerk path; the Expo shell does not. A phone has no cookie jar, so it needs a bearer token from Clerk's React Native SDK, which means a new dependency, a token refresh story, and secure storage for it on the device. The seam is already cut and named — `setAuthTokenProvider` in `apps/mobile/src/lib/api-client.ts` — so this is wiring a provider into an existing hole, not a redesign. It is deferred rather than half-built because the thing that would *prove* it is a live Clerk tenant, and that check does not exist yet either: see the row below. |
| **Live-tenant auth smoke test** | Implied by the Phase 1.2 gap | Nothing in this repo has ever verified that a *genuine* Clerk token is **accepted** — every check is a rejection check, deliberately hermetic so CI needs no tenant and no egress. Accepting one needs real keys against a live instance, i.e. a smoke test run against a deployed environment, which is deployment work this phase has not done. **This is the gate on shipping to a real device:** until it exists, mobile sign-in is `DEV_AUTH_BYPASS` only, and a build handed to anyone but the developer would have no working way in. |
| **Re-enqueue route** | Implied by Milestone A's enqueue-failure path | A record that failed at enqueue is inspectably `failed`, which was the point — nothing is silently stranded. Giving it a retry button means deciding who may press it, whether it re-runs transcription or resumes at extraction, and what happens to drafts already created. It pairs naturally with retry policy above; both land together or neither. |

The one Phase 1 promise **not** deferred: starter badges. Ruled into Phase 1.5,
three of them, minimal — see CLAUDE.md. **Shipped 2026-10-08** (`user_badges`).

## Day-2 items — decided, documented, not built

Things the owner has ruled on but deliberately not implemented while there is
one user. Each is written down so the decision is not re-litigated and the
design is ready when it is needed.

### AI spend limits are a paid-tier feature (ruling 2026-10-08)

Every voice memo costs a Whisper call and a GPT-4o call, and today nothing caps
how many a signed-in user can send. That is acceptable **only** while the owner
is the sole user. The ruling: AI processing will become an additional paid
service, so the cap is not a safety rate limit bolted on later — it is the
boundary between tiers. **No code changes until there is a second user.**

### Tier-based user model (to implement later)

| | Free | Paid |
|---|---|---|
| Task CRUD, XP, streaks, badges, reminders | ✓ | ✓ |
| Voice notes → AI suggestions | small daily allowance (e.g. 3/day) | generous allowance (e.g. 50/day or N audio-minutes) |
| Image input, break-into-steps, LOE, predictive tasks (Phase 2 AI features) | — or trial | ✓ |
| Agents (Phase 3) | — | ✓ |

Numbers are placeholders; the shape is the decision. Design when built:

- **Schema:** `users.plan` (`free` \| `paid`, default `free`) plus
  `plan_changed_at`. Billing provider ids live on their own table, not on
  `users`. No feature-flag vendor: an **entitlements map in `@adhd/shared`**
  (`ENTITLEMENTS[plan] → { dailyMemos, audioMinutes, features[] }`) read by
  both API and clients, so a limit is stated once.
- **Enforcement is server-side only**, at the point of spend: `POST
  /ingestion/audio` (and later image/LLM routes) counts the user's
  `ingestion_records` for their **own calendar day** (`users.timezone`, the
  same rule as streaks) and answers **429** with the limit and the reset time
  before any object is stored. Clients only *display* the allowance.
- **Counted at acceptance, not completion**, so a failed memo still costs an
  allowance slot — the provider was paid either way. Revisit if failures
  become common.
- **Proving checks when built:** the (N+1)th upload in a user-day is 429 with
  no row and no object left behind; the counter resets at the *user's*
  midnight, not the server's; a paid user is not limited at the free number;
  mutation — drop the plan lookup → the paid-user test fails.
- **Global circuit breaker** (separate from tiers): an operator kill-switch env
  var that refuses new AI work with 503 if the provider bill runs away. Cheap,
  and independent of billing.

## Phase 2 plan — milestones

Phase 1 closed 2026-10-08. Ordered; each milestone states what proves it.

- **M1 — Extraction quality + contracts.** Strict JSON-schema output with a
  pinned dated model snapshot and `seed`; a key-gated eval set (~20 golden
  transcripts × 5 runs asserting a stable draft count — it must fail today on
  "Pay the electricity bill this week", which gave 0 then 1 drafts); runtime
  response contracts (zod) in `@adhd/shared`. *Architect recommendations 1–2.*
  **Shipped 2026-10-08** for extraction (zod approved); API-response contracts
  for the clients remain open — see CLAUDE.md "Phase 2 — M1".
- **M2 — Retry policy + re-enqueue (ledger rows, together)**, then provider
  fallback on retryable errors only. **Retry + re-enqueue shipped 2026-10-08**
  (see CLAUDE.md "Phase 2 — M2"); provider fallback deferred — it needs a
  second vendor, which is a dependency decision.
- **M3 — Deployment gate** (the CLAUDE.md checklist): live Clerk smoke test,
  real mobile sessions, real push, device acceptance. Dependencies (approved
  2026-10-08, versions via `npx expo install` for SDK 57):
  - `@clerk/clerk-expo` — wire into `setAuthTokenProvider`; confirm the current
    package name, Clerk has been renaming.
  - `expo-secure-store` — token cache; **has no web implementation**, so Expo
    web needs a fallback or web sign-in breaks.
  - `expo-notifications` + `expo-device` — push registration; needs an EAS
    `projectId`, FCM v1 credentials (Android) and an Apple Developer account
    (iOS APNs). Skip registration on web.
  - EAS development builds — Expo Go cannot do remote push.
  - Proposed alongside (pending approval): Sentry + `nestjs-pino`; a deploy
    target with separate `api`/`worker` processes and a per-environment BullMQ
    queue prefix; Maestro (mobile) / Playwright (web) UI E2E.
- **M4+ — Intelligence features:** image input, break-into-steps, LOE, dynamic
  priority (with keyset pagination), predictive tasks (pgvector in the same
  Postgres), expanded gamification.

## Current Status

**Phase 2 (Intelligence Layer).** Phase 1 closed 2026-10-08. Live status and
the working scope fence live in CLAUDE.md — treat that as the source of truth
rather than restating it here.
