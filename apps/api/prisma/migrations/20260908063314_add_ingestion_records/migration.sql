-- CreateEnum
CREATE TYPE "ingestion_status" AS ENUM ('uploaded', 'transcribing', 'extracting', 'ready', 'failed', 'draft_created');

-- CreateTable
CREATE TABLE "ingestion_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "status" "ingestion_status" NOT NULL DEFAULT 'uploaded',
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ingestion_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingestion_records_user_id_created_at_idx" ON "ingestion_records"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "ingestion_records" ADD CONSTRAINT "ingestion_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
