-- Two changes, both in service of "the audit trail outlives the entity".

-- 1. xp_events.task_id stops cascading and starts nulling.
--
-- The ledger row's claim is "this XP was legitimately earned at this time",
-- and that stays true after the task it was earned on is gone. Cascading
-- deleted the evidence and, worse, refunded the XP — which made
-- undo-by-delete the cheapest XP in the app: complete, earn, delete, repeat.
-- The XP staying put is the anti-farm rule.
--
-- The column is already nullable (streak bonuses carry no task), so this is a
-- constraint swap with no backfill and no data loss.
ALTER TABLE "xp_events" DROP CONSTRAINT "xp_events_task_id_fkey";

ALTER TABLE "xp_events"
  ADD CONSTRAINT "xp_events_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. ingestion_records gets a deletion timestamp.
--
-- Deleting a memo erases the audio, the transcript and the unconfirmed drafts,
-- but keeps the row: what the pipeline did to it is the only remaining account
-- of an object that no longer exists. A timestamp rather than a `deleted`
-- value on ingestion_status because status is the pipeline state machine and
-- the processor's terminal-status guard reads it.
ALTER TABLE "ingestion_records" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
