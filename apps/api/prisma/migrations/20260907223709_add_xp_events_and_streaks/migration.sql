-- CreateEnum
CREATE TYPE "xp_event_type" AS ENUM ('task_complete', 'streak_bonus');

-- CreateTable
CREATE TABLE "xp_events" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID,
    "type" "xp_event_type" NOT NULL,
    "xp_amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xp_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streaks" (
    "user_id" UUID NOT NULL,
    "current_streak" INTEGER NOT NULL DEFAULT 0,
    "longest_streak" INTEGER NOT NULL DEFAULT 0,
    "last_active_date" DATE,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "streaks_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "xp_events_user_id_idx" ON "xp_events"("user_id");

-- CreateIndex
CREATE INDEX "xp_events_task_id_idx" ON "xp_events"("task_id");

-- AddForeignKey
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streaks" ADD CONSTRAINT "streaks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
