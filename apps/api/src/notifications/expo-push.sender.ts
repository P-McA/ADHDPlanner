import { PUSH_BATCH_SIZE, PUSH_SEND_TIMEOUT_MS } from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';

import type { PushFailureReason, PushMessage, PushReceipt, PushSender } from './notifications.ports.js';

/**
 * Expo's push service, over `fetch`.
 *
 * No vendor SDK, for the same reason the OpenAI adapters have none: this is one
 * POST with a JSON body, Node 24 has `fetch`, and `expo-server-sdk` would add a
 * dependency to own the two things below — chunking and error mapping — which
 * are eleven lines and are exactly the part we need to be able to test.
 *
 * As with `src/ai/`, this file is the boundary: **nothing outside it may import
 * fetch-with-an-exp.host-URL.** Everything else in the app talks to
 * `PUSH_SENDER`.
 */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Expo's documented `details.error` values, mapped to the only distinction the
 * caller cares about — is this device gone, or is this a bad moment?
 *
 * Anything unrecognised becomes `unknown`, which deletes nothing. A provider
 * adding a new error code must not be able to unsubscribe users by surprise.
 */
const ERROR_REASONS: Record<string, PushFailureReason> = {
  DeviceNotRegistered: 'device_not_registered',
  MessageTooBig: 'message_too_big',
  MessageRateExceeded: 'message_rate_exceeded',
  InvalidCredentials: 'invalid_credentials',
};

/** One entry in Expo's `data` array. Only the fields this adapter reads. */
interface ExpoTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

@Injectable()
export class ExpoPushSender implements PushSender {
  private readonly logger = new Logger(ExpoPushSender.name);

  async send(messages: PushMessage[]): Promise<PushReceipt[]> {
    const receipts: PushReceipt[] = [];

    for (let from = 0; from < messages.length; from += PUSH_BATCH_SIZE) {
      const batch = messages.slice(from, from + PUSH_BATCH_SIZE);

      receipts.push(...(await this.sendBatch(batch)));
    }

    return receipts;
  }

  /**
   * One request. Every failure path returns receipts rather than throwing —
   * see the contract note on `PushSender.send`.
   */
  private async sendBatch(batch: PushMessage[]): Promise<PushReceipt[]> {
    let response: Response;

    try {
      response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(
          batch.map((message) => ({
            to: message.token,
            title: message.title,
            body: message.body,
            ...(message.data ? { data: message.data } : {}),
          })),
        ),
        // A hung provider must not hold the sweep open; the next run would pile
        // up behind it and its claims would block the retry.
        signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      return this.allFailed(batch, 'transport', describe(error));
    }

    if (!response.ok) {
      // A 4xx/5xx is about the request, not any one device: an auth failure
      // here would otherwise look like every device being unregistered at once.
      const reason: PushFailureReason = response.status === 401 || response.status === 403
        ? 'invalid_credentials'
        : 'transport';

      return this.allFailed(batch, reason, `HTTP ${String(response.status)}`);
    }

    let payload: { data?: ExpoTicket[] };

    try {
      payload = (await response.json()) as { data?: ExpoTicket[] };
    } catch (error: unknown) {
      return this.allFailed(batch, 'transport', describe(error));
    }

    const tickets = payload.data;

    if (!Array.isArray(tickets) || tickets.length !== batch.length) {
      // Positional correlation is the only correlation Expo offers, so a
      // length mismatch means we cannot say which device each ticket refers to.
      // Guessing here would delete the wrong user's registration.
      return this.allFailed(batch, 'unknown', 'provider returned a mismatched ticket count');
    }

    return batch.map((message, index) => this.toReceipt(message, tickets[index]));
  }

  private toReceipt(message: PushMessage, ticket: ExpoTicket | undefined): PushReceipt {
    if (ticket?.status === 'ok') {
      return { token: message.token, ok: true };
    }

    const code = ticket?.details?.error;
    const reason = (code ? ERROR_REASONS[code] : undefined) ?? 'unknown';

    if (reason === 'unknown' && code) {
      // Worth a line: an error code Expo has added and we do not map is the
      // signal to update ERROR_REASONS, and it is invisible otherwise.
      this.logger.warn(`Unmapped Expo push error "${code}"`);
    }

    return {
      token: message.token,
      ok: false,
      reason,
      detail: ticket?.message ?? code ?? 'provider reported no detail',
    };
  }

  private allFailed(
    batch: PushMessage[],
    reason: PushFailureReason,
    detail: string,
  ): PushReceipt[] {
    this.logger.warn(`Push batch of ${String(batch.length)} failed (${reason}): ${detail}`);

    return batch.map((message) => ({ token: message.token, ok: false, reason, detail }));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
