-- AlterEnum
ALTER TYPE "xp_event_type" ADD VALUE 'estimate_reviewed';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "estimate_minutes" INTEGER,
ADD COLUMN     "suggested_estimate_minutes" INTEGER;
