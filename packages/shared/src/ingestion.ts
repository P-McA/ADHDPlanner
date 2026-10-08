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

/**
 * Why a failed memo failed, as far as retrying is concerned.
 *
 * `retryable` is a bad moment — a rate limit, a provider 5xx, a timeout, a
 * dropped connection, a job that never reached the queue — and the pipeline
 * retries it on its own, a few times. `permanent` is a no that will be the same
 * no next time — a 400 on the file, our own credentials refused, a model
 * refusal — so it is never retried automatically, because each automatic retry
 * of a metered call costs money for the same answer. Either kind can still be
 * retried by the user (`POST /ingestion/:id/retry`), because a fix shipped
 * since can turn yesterday's permanent into today's success.
 */
export const INGESTION_FAILURE_KINDS = ['retryable', 'permanent'] as const;

export type IngestionFailureKind = (typeof INGESTION_FAILURE_KINDS)[number];

/**
 * How many times the pipeline retries a `retryable` failure by itself before
 * parking the memo on `failed` for a human. Per memo, per run: a manual retry
 * starts a fresh run with a fresh allowance. Deliberately not per user or per
 * day — that is the spend limit, which is a Day-2 decision (docs/adhd_tracker.md).
 */
export const MAX_AUTO_RETRIES = 3;

/**
 * The wait before each automatic retry: index 0 is the first. Long enough that
 * a rate limit has a chance to lift, short enough that a phone still watching
 * the memo sees it finish.
 */
export const AUTO_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000];

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
  /**
   * Failure reason when `status` is `failed`. While an automatic retry is
   * waiting (`status` back on `uploaded`, `autoRetries` above zero) it holds
   * the error that caused the retry, so "slow" and "struggling" stay
   * distinguishable. Null otherwise.
   */
  error: string | null;
  /** Set exactly when `status` is `failed`; see {@link IngestionFailureKind}. */
  failureKind: IngestionFailureKind | null;
  /** Automatic retries spent in the current run, 0 to {@link MAX_AUTO_RETRIES}. */
  autoRetries: number;
  /**
   * When the user erased the memo, ISO 8601; null for a live record.
   *
   * A deleted record keeps its `status` and `error` — what the pipeline did is
   * the only remaining account of an object that no longer exists — but its
   * audio, transcript and unconfirmed drafts are gone for real.
   */
  deletedAt: string | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
}

/**
 * Body of `DELETE /ingestion/:id`.
 *
 * `deletedDrafts` counts only the *unconfirmed* suggestions this memo
 * produced. A draft the user approved has stopped being the memo's and become
 * their own work, so it survives — and if it paid XP, that XP survives too.
 */
export interface DeleteIngestionResult {
  id: string;
  deletedDrafts: number;
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

/**
 * The multipart field the audio must arrive in.
 *
 * Here rather than in the API because it is half of a contract: the server
 * reads exactly this name and every client has to send exactly this name. A
 * mismatch is invisible in the happy path and produces a 400 that describes a
 * missing file rather than a misnamed one, which is a bad half-hour. Clients
 * import it; nobody types the string.
 */
export const AUDIO_UPLOAD_FIELD = 'file';

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
