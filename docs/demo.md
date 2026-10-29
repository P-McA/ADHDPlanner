# Demo rehearsal

A five-minute run through the PoC. Rehearse it twice, then record it once as a
fallback.

## Before the demo

1. Deploy both apps (`docs/deployment.md`) and confirm
   `curl -fsS https://adhd-planner-api.fly.dev/health` is 200.
2. Seed the demo account against the deployed database:

   ```sh
   DATABASE_URL=... pnpm --filter @adhd/api db:seed:demo
   ```

3. Sign in on the phone as `dev_demo` (or the Clerk account mapped to it) and
   confirm the list loads with history.
4. Press **Suggest tasks** once so the embedding pass has run; the suggestions
   should appear under the violet card.
5. Set `AI_KILL_SWITCH=false` on the API.

## The script

1. **Open on the list.** Point out Next up: the urgent bill is first, with its
   reason line.
2. **Type a task** in quick add: "Ring the vet about the booster", Tomorrow.
   It appears immediately — the user's own, no review step.
3. **Photograph a sticky note** with two lines on it. Say the fence out loud:
   nothing is a task until approved. Approve one suggestion, reject the other.
4. **Complete the top task.** The XP and streak move; the freeze chip is
   visible.
5. **Break a streak, then show the freeze.** (Optional: use the seeded account
   and skip a day beforehand.) The freeze is spent automatically and the run
   survives.
6. **Show the weekly digest** in the notification tray from the Monday send.
7. **Close on the fence**: AI drafts, the user decides.

## Fallback

If the live API or provider misbehaves:

- Switch `AI_KILL_SWITCH=true`; capture still stores and queues, and the UI
  says the memo failed rather than hanging.
- Play the recorded video instead of the live run.
- The seeded account and its history are already on disk, so a fresh deploy can
  be reseeded in under a minute.

## What not to demo

- Leaderboards, offline sync, agents, recurring tasks — none are built.
- A fresh account's Suggest tasks: it correctly says "Nothing to suggest yet",
  which looks like a bug to anyone who has not read the algorithm.
