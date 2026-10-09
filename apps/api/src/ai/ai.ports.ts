import type { DraftCandidate, EstimateMinutes, StepCandidate } from '@adhd/shared';

/**
 * The boundary between this application and whoever does the machine learning.
 *
 * Two methods, both taking and returning plain data. Nothing outside
 * `openai.transcriber.ts` and `openai.extractor.ts` may talk to a provider —
 * the worker depends on these interfaces, so the e2e suite substitutes fakes
 * that implement the same contract from fixtures, and swapping provider (to
 * LiteLLM, Deepgram, a self-hosted whisper) is a new adapter rather than a
 * change to the pipeline.
 */

/** Speech to text. */
export interface Transcriber {
  /**
   * @param audio raw bytes as uploaded
   * @param mimetype the content type the client declared
   * @returns what was said; an empty string when the memo held no speech
   */
  transcribe(audio: Buffer, mimetype: string): Promise<string>;
}

/** Text to task drafts. */
export interface Extractor {
  /**
   * @returns the tasks found, in the order they were said; empty when there
   * were none. Returning nothing is a valid, common answer — see the prompt.
   */
  extract(transcript: string): Promise<DraftCandidate[]>;
}

/** What "break this into steps" is told about the task. */
export interface DecompositionInput {
  title: string;
  description: string | null;
}

/** A task to small concrete steps. */
export interface Decomposer {
  /**
   * @returns the steps, in the order they should be done; empty when the task
   * is already one step. Throws a `ProviderError` when the provider says no.
   */
  decompose(task: DecompositionInput): Promise<StepCandidate[]>;
}

/** What "how long will this take?" is told about the task. */
export type EstimationInput = DecompositionInput;

/** A task to a suggested estimate, in one of the minute buckets. */
export interface Estimator {
  /** Throws a `ProviderError` when the provider says no or gives no usable bucket. */
  estimate(task: EstimationInput): Promise<EstimateMinutes>;
}

// Interfaces vanish at runtime, so Nest needs a token to inject against.
export const TRANSCRIBER = Symbol('Transcriber');
export const EXTRACTOR = Symbol('Extractor');
export const DECOMPOSER = Symbol('Decomposer');
export const ESTIMATOR = Symbol('Estimator');
