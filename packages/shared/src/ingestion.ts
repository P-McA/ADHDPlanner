import type { TaskPriority } from './task.js';

/**
 * Voice ingestion contracts (Phase 1.4).
 *
 * The pipeline is deliberately not a task factory. It ends at `draft_created`,
 * and the tasks it creates are drafts the user must confirm — nothing here
 * ever produces live work. See CLAUDE.md: human-in-the-loop is the fence.
 */

/**
 * The stages one upload passes through.
 *
 * `draft_created` and `failed` are terminal. There is no `ready` between
 * extraction and drafts: the pipeline creates the drafts in the same
 * transaction that ends it, so a state meaning "extracted but not yet written"
 * could never be observed — and the schema's own rule is that an enum value
 * the code cannot produce is dead schema.
 */
export const INGESTION_STATUSES = [
  'uploaded',
  'transcribing',
  'extracting',
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
  /**
   * What the memo turned out to say. Null until transcription succeeds.
   *
   * Kept even when extraction later finds nothing, because "we heard you, and
   * there was no task in it" is a different answer from "something broke" —
   * and it is the only way the user can check the machine heard them right.
   */
  transcript: string | null;
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

/**
 * One task the extractor believes it heard.
 *
 * Deliberately narrow. The model is asked for a title and, at most, a due date
 * and a priority — everything else a task can carry is something the user is
 * better placed to decide than a transcript is, and inventing it would make
 * the draft look more considered than it is.
 */
export interface DraftCandidate {
  title: string;
  dueAt: string | null;
  manualPriority: TaskPriority | null;
}

/**
 * How long a provider call may take before the worker gives up on it.
 *
 * A hung provider must become a `failed` record with the reason stored, not a
 * worker that never returns and a memo that sits on `transcribing` forever.
 * Transcription gets the longer budget because it scales with the length of
 * the audio — 25 MB of speech is minutes of it — while extraction is one
 * bounded prompt over text that is already in hand.
 */
export const TRANSCRIPTION_TIMEOUT_MS = 60_000;
export const EXTRACTION_TIMEOUT_MS = 30_000;
