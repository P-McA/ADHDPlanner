/**
 * The push provider boundary — the same shape as `ai.ports.ts`, and for the
 * same reason: the e2e suite exercises the real sweep, the real database and
 * the real dispatch ledger, with the only fake being the thing that would
 * otherwise reach the network and a stranger's phone.
 *
 * Nothing here knows what Expo is. An implementation over APNs and FCM
 * directly would satisfy this interface unchanged.
 */

/** One notification, addressed to one device. */
export interface PushMessage {
  /** The device's push token. */
  token: string;
  title: string;
  body: string;
  /** Opaque payload the app reads on tap; used to deep-link to the task. */
  data?: Record<string, string>;
}

/**
 * Why one message did not arrive.
 *
 * This enumeration exists so the caller can tell *permanent* from *transient*,
 * which is the only question that matters when deciding whether to delete a
 * device registration. A token that has been uninstalled is gone for good and
 * must be removed or it will be retried every day for ever. A token that hit a
 * rate limit is perfectly good and deleting it would silently unsubscribe a
 * user who did nothing wrong — an unrecoverable data loss caused by a
 * transient provider condition.
 *
 * So: `device_not_registered` is the only value that justifies deletion, and
 * `PushTokensService.pruneDeadTokens` acts on exactly that one.
 */
export type PushFailureReason =
  /** The app was uninstalled or the token was invalidated. Permanent — delete. */
  | 'device_not_registered'
  /** The payload exceeded the provider's size limit. Our bug, not the device's. */
  | 'message_too_big'
  /** Sending too fast. Transient; the device is fine. */
  | 'message_rate_exceeded'
  /** Our provider credentials are wrong. Affects everyone, deletes nobody. */
  | 'invalid_credentials'
  /** The request never got an answer — network, timeout, provider down. */
  | 'transport'
  /** The provider said no in a way this adapter does not recognise. */
  | 'unknown';

/**
 * What became of one message.
 *
 * Carries the token rather than relying on positional correlation with the
 * request: the caller uses this to decide which registrations to delete, and
 * "delete the token at index 7" is one off-by-one away from unsubscribing the
 * wrong person.
 */
export interface PushReceipt {
  token: string;
  ok: boolean;
  /** Set when `ok` is false. */
  reason?: PushFailureReason;
  /** The provider's own words, kept verbatim for the dispatch row. */
  detail?: string;
}

export interface PushSender {
  /**
   * Delivers a batch and reports on each message individually.
   *
   * **Never throws**, and that is a contract rather than an implementation
   * detail. The same rule as `AudioIngestionProcessor`: a dead push channel is
   * an ordinary Tuesday for a notification provider, and it must not be able to
   * take out the sweep that calls it — still less the API the sweep runs
   * inside. A total failure comes back as a full set of `transport` receipts,
   * so "everything failed" and "these three failed" are the same code path for
   * the caller.
   *
   * Returns exactly one receipt per message. Batching over the provider's
   * per-request limit is the adapter's business, not the caller's.
   */
  send(messages: PushMessage[]): Promise<PushReceipt[]>;
}

/** DI token — an interface does not survive to runtime. */
export const PUSH_SENDER = Symbol('PushSender');
