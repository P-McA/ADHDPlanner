/**
 * Provider configuration, shared by the two adapters.
 *
 * The base URL is a constant, not config. There is one environment that talks
 * to a real provider today, and inventing a knob for a second one would be the
 * same speculative surface we declined for the S3 endpoint. When a second
 * environment genuinely needs it, it becomes an env var then.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * The API key, resolved per call rather than at construction.
 *
 * Lazy on purpose. Reading it in a constructor would make the key a
 * requirement for the process to *boot*, which would break local development
 * with no key at all and would break the key-gated integration test, which
 * skips itself when the key is absent — it cannot skip if the app already
 * refused to start. Resolving it here means a keyless environment works
 * perfectly until the moment something actually asks a provider a question,
 * and then fails with a sentence that says what to do.
 */
export function openAiKey(): string {
  const key = process.env.OPENAI_API_KEY;

  if (key === undefined || key === '') {
    throw new Error(
      'OPENAI_API_KEY is not set: transcription and extraction cannot run. ' +
        'Set it in apps/api/.env to process voice memos locally.',
    );
  }

  return key;
}
