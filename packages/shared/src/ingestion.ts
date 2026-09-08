/**
 * Voice ingestion contracts (Phase 1.4).
 *
 * The pipeline is deliberately not a task factory. It ends at `draft_created`,
 * and the tasks it creates are drafts the user must confirm — nothing here
 * ever produces live work. See CLAUDE.md: human-in-the-loop is the fence.
 */

export const INGESTION_STATUSES = [
  'uploaded',
  'transcribing',
  'extracting',
  'ready',
  'failed',
  'draft_created',
] as const;

export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

/** One media upload on its way to becoming task drafts. */
export interface IngestionRecord {
  id: string;
  userId: string;
  /** Key within the private bucket. Not a URL — the bucket grants no public read. */
  objectKey: string;
  status: IngestionStatus;
  /** Failure reason when `status` is `failed`, null otherwise. */
  error: string | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/**
 * Body of `202 Accepted` from `POST /ingestion/audio`.
 *
 * The upload is accepted, not finished: transcription and extraction happen on
 * a worker, so the caller gets an id to poll rather than a result. 202 rather
 * than 201 says exactly that.
 */
export interface IngestionAccepted {
  id: string;
  status: IngestionStatus;
}

/** Largest audio upload accepted, in bytes. */
export const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Bucket holding voice memos. Private; no public read policy is ever set. */
export const VOICE_MEMO_BUCKET = 'voice-memos';

/** BullMQ queue that carries an ingestion record id to the (Milestone B) worker. */
export const AUDIO_INGESTION_QUEUE = 'audio-ingestion';

/** Payload of one `audio-ingestion` job. */
export interface AudioIngestionJob {
  ingestionRecordId: string;
}
