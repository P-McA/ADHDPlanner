import { describe, expect, it } from 'vitest';

import { classifyFailure, isRetryableStatus, ProviderError } from './provider-error.js';

describe('isRetryableStatus', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries a %i, which is about the moment', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  // 401 is our own key: retrying it never works, and a burst of them is how
  // an account gets flagged.
  it.each([400, 401, 403, 404, 413, 415, 422])(
    'does not retry a %i, which is about the request',
    (status) => {
      expect(isRetryableStatus(status)).toBe(false);
    },
  );
});

describe('classifyFailure', () => {
  it('takes a provider error at its word', () => {
    expect(classifyFailure(ProviderError.fromStatus('Whisper returned 429', 429))).toBe('retryable');
    expect(classifyFailure(ProviderError.fromStatus('Whisper returned 400', 400))).toBe('permanent');
    expect(classifyFailure(new ProviderError('Extraction was refused', 'permanent'))).toBe('permanent');
  });

  it('retries a deadline that ran out', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';

    expect(classifyFailure(timeout)).toBe('retryable');
  });

  it('retries a connection that never completed', () => {
    expect(classifyFailure(new TypeError('fetch failed'))).toBe('retryable');
  });

  it('calls anything it has never seen permanent, rather than paying to guess', () => {
    expect(classifyFailure(new Error('NoSuchKey: the specified key does not exist'))).toBe('permanent');
    expect(classifyFailure(new Error('Extraction returned content that is not JSON'))).toBe('permanent');
    expect(classifyFailure(new TypeError('Cannot read properties of undefined'))).toBe('permanent');
    expect(classifyFailure('a string, not even an Error')).toBe('permanent');
  });
});
