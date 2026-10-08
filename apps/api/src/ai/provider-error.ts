import type { IngestionFailureKind } from '@adhd/shared';

/**
 * A provider said no, and how it said it decides whether asking again could
 * help. Thrown by the adapters behind `TRANSCRIBER`/`EXTRACTOR`, so the
 * pipeline can classify a failure without parsing error strings.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: IngestionFailureKind,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** A failed HTTP answer, classified by its status. */
  static fromStatus(message: string, status: number): ProviderError {
    return new ProviderError(message, isRetryableStatus(status) ? 'retryable' : 'permanent');
  }
}

/**
 * 408 and 429 are "not now"; a 5xx is the provider's own trouble. Every other
 * 4xx is about the request — the file, the schema, our key — and will be
 * refused identically next time, so retrying it only buys the same bill.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Whether a pipeline failure is worth retrying on its own.
 *
 * Retryable: a classified provider answer that says so, a deadline that ran
 * out (`AbortSignal.timeout` throws `TimeoutError`), and a connection that
 * never completed (`fetch` throws `TypeError: fetch failed`). Everything else —
 * including anything this code has never seen — is `permanent`. An unknown
 * failure retried automatically is money spent on a guess; one parked on
 * `failed` costs the user a tap on Retry.
 */
export function classifyFailure(error: unknown): IngestionFailureKind {
  if (error instanceof ProviderError) return error.kind;

  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'retryable';
    if (error instanceof TypeError && error.message === 'fetch failed') return 'retryable';
  }

  return 'permanent';
}
