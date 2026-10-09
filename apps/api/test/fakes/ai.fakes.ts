import type { DraftCandidate, EstimateMinutes, StepCandidate } from '@adhd/shared';

import type {
  Decomposer,
  DecompositionInput,
  EstimationInput,
  Estimator,
  Extractor,
  Transcriber,
} from '../../src/ai/ai.ports.js';

/**
 * Stand-ins for the two provider adapters, implementing the same interfaces.
 *
 * This is the whole point of `ai.ports.ts`: the e2e suite exercises the real
 * pipeline — real database, real object storage, real queue rows — with the
 * only fake being the boundary that would otherwise cost money and network.
 * Nothing here knows what OpenAI is, so a test that passes against these is a
 * test of our code rather than of a mock's shape.
 *
 * Both are programmable, because half of what the pipeline has to get right is
 * what it does when a provider says no.
 */

/** The memo the fake "heard". Chosen to contain one commitment and one aside. */
export const FAKE_TRANSCRIPT =
  "The car's been making that noise again. I need to book the car in before the MOT runs out.";

/** What the fake extractor finds in it: the commitment, not the aside. */
export const FAKE_CANDIDATES: DraftCandidate[] = [
  { title: 'Book the car in', dueAt: null, manualPriority: null },
];

export class FakeTranscriber implements Transcriber {
  /** Replace to make the next call fail, or to change what was heard. */
  result: () => Promise<string> = () => Promise.resolve(FAKE_TRANSCRIPT);

  /** Every call made, so a test can prove a resumed record skipped this. */
  readonly calls: { bytes: number; mimetype: string }[] = [];

  transcribe(audio: Buffer, mimetype: string): Promise<string> {
    this.calls.push({ bytes: audio.byteLength, mimetype });

    return this.result();
  }
}

export class FakeExtractor implements Extractor {
  result: () => Promise<DraftCandidate[]> = () => Promise.resolve([...FAKE_CANDIDATES]);

  readonly calls: string[] = [];

  extract(transcript: string): Promise<DraftCandidate[]> {
    this.calls.push(transcript);

    return this.result();
  }
}

/** The error an `AbortSignal.timeout` deadline actually produces. */
export function timeoutError(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';

  return error;
}

/** What the fake decomposer proposes unless a test says otherwise. */
export const FAKE_STEPS: StepCandidate[] = [
  { title: 'Find the reminder letter' },
  { title: 'Ring the garage' },
  { title: 'Put the date in the calendar' },
];

export class FakeDecomposer implements Decomposer {
  result: () => Promise<StepCandidate[]> = () => Promise.resolve([...FAKE_STEPS]);

  /** Every task it was asked about, so a test can prove it was not asked. */
  readonly calls: DecompositionInput[] = [];

  decompose(task: DecompositionInput): Promise<StepCandidate[]> {
    this.calls.push(task);

    return this.result();
  }
}

/** What the fake estimator answers unless a test says otherwise. */
export const FAKE_ESTIMATE: EstimateMinutes = 30;

export class FakeEstimator implements Estimator {
  result: () => Promise<EstimateMinutes> = () => Promise.resolve(FAKE_ESTIMATE);

  /** Every task it was asked about, so a test can prove it was not asked. */
  readonly calls: EstimationInput[] = [];

  estimate(task: EstimationInput): Promise<EstimateMinutes> {
    this.calls.push(task);

    return this.result();
  }
}
