-- CreateEnum
CREATE TYPE "ingestion_kind" AS ENUM ('audio', 'image');

-- AlterTable
ALTER TABLE "ingestion_records" ADD COLUMN     "kind" "ingestion_kind" NOT NULL DEFAULT 'audio';
