-- CreateEnum
CREATE TYPE "ingestion_failure_kind" AS ENUM ('retryable', 'permanent');

-- AlterTable
ALTER TABLE "ingestion_records" ADD COLUMN     "auto_retries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "enqueue_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failure_kind" "ingestion_failure_kind";

-- Backfill: rows already on `failed` predate classification. They were never
-- retried automatically, and nothing will now, so `permanent` is the honest
-- label; the user can still retry any of them by hand.
UPDATE "ingestion_records" SET "failure_kind" = 'permanent' WHERE "status" = 'failed';
