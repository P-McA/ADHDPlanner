import type { PushMessage, PushReceipt, PushSender } from '../../src/notifications/notifications.ports.js';

/**
 * Stand-in for the push provider, implementing the same interface.
 *
 * The same bargain as `ai.fakes.ts`: the e2e suite runs the real sweep against
 * the real database and the real dispatch ledger, and the only thing faked is
 * the hop that would otherwise reach the network and a stranger's lock screen.
 * Nothing here knows what Expo is.
 *
 * It is programmable in both directions because most of what the sweep has to
 * get right is what it does when the provider says no — and because token
 * cleanup is driven entirely by *which* no it said.
 */
export class FakePushSender implements PushSender {
  /**
   * Every batch handed to `send`, in order.
   *
   * This is what the idempotency tests assert on: run the sweep twice and this
   * array must not grow the second time. Counting sends is the only way to see
   * a double-send — the dispatch table would look identical either way.
   */
  readonly batches: PushMessage[][] = [];

  /**
   * What to answer with. Default: everything delivered.
   *
   * Takes the batch so a test can fail one specific token — the case the whole
   * `PushReceipt.token` field exists for.
   */
  respondWith: (messages: PushMessage[]) => PushReceipt[] = (messages) =>
    messages.map((message) => ({ token: message.token, ok: true }));

  send(messages: PushMessage[]): Promise<PushReceipt[]> {
    this.batches.push([...messages]);

    return Promise.resolve(this.respondWith(messages));
  }

  /** Every message across every batch, for tests that do not care about batching. */
  get sent(): PushMessage[] {
    return this.batches.flat();
  }

  /** Messages addressed to one device. */
  sentTo(token: string): PushMessage[] {
    return this.sent.filter((message) => message.token === token);
  }

  reset(): void {
    this.batches.length = 0;
  }
}

/**
 * A sender that fails every message the way a dead device does.
 *
 * Deliberately a named helper rather than an inline lambda in each test:
 * `device_not_registered` is the one reason that deletes a row, so the tests
 * that use it are the tests that prove deletion, and they should be greppable.
 */
export function deviceGone(messages: PushMessage[]): PushReceipt[] {
  return messages.map((message) => ({
    token: message.token,
    ok: false,
    reason: 'device_not_registered' as const,
    detail: '"ExponentPushToken[...]" is not a registered push notification recipient',
  }));
}

/** A sender that fails every message the way a rate limit does — transient, deletes nothing. */
export function rateLimited(messages: PushMessage[]): PushReceipt[] {
  return messages.map((message) => ({
    token: message.token,
    ok: false,
    reason: 'message_rate_exceeded' as const,
    detail: 'You are sending messages too frequently',
  }));
}
