-- pgvector, owner-approved 2026-10-09. Needs the pgvector/pgvector image
-- (docker-compose.yml, ci.yml); on plain postgres:16 this line fails, loudly,
-- which is the right way for it to fail.
CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "suggestion_reason" TEXT;

-- CreateTable
CREATE TABLE "task_embeddings" (
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_embeddings_pkey" PRIMARY KEY ("task_id")
);

-- CreateIndex
CREATE INDEX "task_embeddings_user_id_idx" ON "task_embeddings"("user_id");

-- AddForeignKey
ALTER TABLE "task_embeddings" ADD CONSTRAINT "task_embeddings_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
