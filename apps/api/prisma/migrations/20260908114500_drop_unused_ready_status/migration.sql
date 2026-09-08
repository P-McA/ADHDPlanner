-- Drops the unused `ready` value from ingestion_status.
--
-- Milestone B's pipeline goes uploaded → transcribing → extracting →
-- draft_created (or failed), creating the drafts in the same transaction that
-- ends the run. There is no moment at which "extracted but not yet written"
-- is observable, so `ready` is a value no code path can produce — dead schema
-- by the same rule the XpEvent enum is documented under.
--
-- Postgres has no ALTER TYPE ... DROP VALUE, so the type is rebuilt. Safe
-- without a backfill because no row can hold the value being removed: the
-- guard below fails the migration loudly rather than silently losing data if
-- that assumption is ever wrong.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ingestion_records" WHERE "status" = 'ready') THEN
    RAISE EXCEPTION 'ingestion_records still has rows with status=ready';
  END IF;
END $$;

ALTER TYPE "ingestion_status" RENAME TO "ingestion_status_old";

CREATE TYPE "ingestion_status" AS ENUM ('uploaded', 'transcribing', 'extracting', 'failed', 'draft_created');

ALTER TABLE "ingestion_records" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ingestion_records" ALTER COLUMN "status" TYPE "ingestion_status" USING ("status"::text::"ingestion_status");
ALTER TABLE "ingestion_records" ALTER COLUMN "status" SET DEFAULT 'uploaded';

DROP TYPE "ingestion_status_old";
