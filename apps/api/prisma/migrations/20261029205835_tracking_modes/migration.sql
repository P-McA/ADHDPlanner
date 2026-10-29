-- CreateEnum
CREATE TYPE "tracking_mode" AS ENUM ('metrics', 'xp');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "started_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "show_elo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tracking_mode" "tracking_mode" NOT NULL DEFAULT 'metrics';

-- CreateTable
CREATE TABLE "performance_events" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID,
    "local_date" DATE NOT NULL,
    "complexity" DOUBLE PRECISION NOT NULL,
    "speed_factor" DOUBLE PRECISION NOT NULL,
    "score" INTEGER NOT NULL,
    "formula_version" INTEGER NOT NULL DEFAULT 1,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "performance_events_user_id_local_date_idx" ON "performance_events"("user_id", "local_date");

-- CreateIndex
CREATE INDEX "performance_events_task_id_idx" ON "performance_events"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_events_user_id_task_id_local_date_key" ON "performance_events"("user_id", "task_id", "local_date");

-- AddForeignKey
ALTER TABLE "performance_events" ADD CONSTRAINT "performance_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_events" ADD CONSTRAINT "performance_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
