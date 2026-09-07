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

## Current Status

Phase 1 (MVP). Live status and the working scope fence live in CLAUDE.md —
treat that as the source of truth rather than restating it here.
