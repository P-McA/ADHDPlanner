-- AlterTable
ALTER TABLE "ingestion_records" ADD COLUMN     "transcript" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "confirmed_at" TIMESTAMPTZ(6),
ADD COLUMN     "ingestion_record_id" UUID;

-- CreateIndex
CREATE INDEX "tasks_ingestion_record_id_idx" ON "tasks"("ingestion_record_id");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_ingestion_record_id_fkey" FOREIGN KEY ("ingestion_record_id") REFERENCES "ingestion_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
