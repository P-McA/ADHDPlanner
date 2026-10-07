-- Completion XP is paid at most once per task per day of the user's own
-- calendar. The key is built in GamificationService (completionAwardKey) and
-- inserted with ON CONFLICT DO NOTHING, so a second completion the same day
-- leaves the task done and pays nothing. Existing rows get NULL, which never
-- collides: Postgres treats NULLs as distinct in a unique index.

-- AlterTable
ALTER TABLE "xp_events" ADD COLUMN     "award_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "xp_events_user_id_award_key_key" ON "xp_events"("user_id", "award_key");

