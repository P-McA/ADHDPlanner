-- CreateEnum
CREATE TYPE "task_source" AS ENUM ('manual', 'voice', 'image', 'agent', 'ai_suggested');

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "parent_task_id" UUID,
ADD COLUMN     "source" "task_source" NOT NULL DEFAULT 'manual';

-- CreateIndex
CREATE INDEX "tasks_parent_task_id_idx" ON "tasks"("parent_task_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
