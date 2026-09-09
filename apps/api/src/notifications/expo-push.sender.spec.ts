import { PUSH_BATCH_SIZE } from '@adhd/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExpoPushSender } from './expo-push.sender.js';
import type { PushMessage } from './notifications.ports.js';

/**
 * The adapter, with `fetch` stubbed.
 *
 * Stubbing the network *here* is the one place it proves something: this file
 * is the boundary, and what is under test is the translation across it — the
 * request we build and, far more importantly, the meaning we assign to each
 * answer. Every layer above talks to `PUSH_SENDER` and is tested against a
 * fake implementing the same interface, which is why none of them have to
 * know what a ticket is.
 */

const ok = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

const message = (token: string): PushMessage => ({
  token,
  title: 'Due today',
  body: 'Book the car in',
});

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

let fetchMock: ReturnType<typeof vi.fn<FetchLike>>;
let sender: ExpoPushSender;

beforeEach(() => {
  fetchMock = vi.fn<FetchLike>();
  vi.stubGlobal('fetch', fetchMock);
  sender = new ExpoPushSender();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExpoPushSender', () => {
  it('posts the batch to Expo and reports each message delivered', async () => {
    fetchMock.mockResolvedValue(ok({ data: [{ status: 'ok' }, { status: 'ok' }] }));

    const receipts = await sender.send([message('tok-1'), message('tok-2')]);

    expect(receipts).toEqual([
      { token: 'tok-1', ok: true },
      { token: 'tok-2', ok: true },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(init.method).toBe('POST');
    // A hung provider must not hold the sweep open.
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body as string) as { to: string; title: string }[];
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ to: 'tok-1', title: 'Due today' });
  });

  it('names a dead device as permanently gone, which is the only reason that deletes a token', async () => {
    fetchMock.mockResolvedValue(
      ok({
        data: [
          {
            status: 'error',
            message: '"ExponentPushToken[x]" is not a registered push notification recipient',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      }),
    );

    const [receipt] = await sender.send([message('tok-1')]);

    expect(receipt).toMatchObject({ token: 'tok-1', ok: false, reason: 'device_not_registered' });
    // The provider's own words, kept for the dispatch row.
    expect(receipt?.detail).toContain('not a registered push notification recipient');
  });

  it('keeps a transient failure transient, so a rate limit never unsubscribes anyone', async () => {
    fetchMock.mockResolvedValue(
      ok({
        data: [{ status: 'error', message: 'Too fast', details: { error: 'MessageRateExceeded' } }],
      }),
    );

    const [receipt] = await sender.send([message('tok-1')]);

    expect(receipt?.reason).toBe('message_rate_exceeded');
    expect(receipt?.reason).not.toBe('device_not_registered');
  });

  it('calls an error code it has never seen `unknown`, and deletes nothing', async () => {
    fetchMock.mockResolvedValue(
      ok({ data: [{ status: 'error', details: { error: 'SomeCodeExpoAddedLastTuesday' } }] }),
    );

    const [receipt] = await sender.send([message('tok-1')]);

    // A provider adding a code must not be able to unsubscribe users by
    // surprise. The default has to be the safe direction, not the tidy one.
    expect(receipt?.reason).toBe('unknown');
    expect(receipt?.detail).toBe('SomeCodeExpoAddedLastTuesday');
  });

  it('does not throw when the network does — it answers in receipts', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND exp.host'));

    const receipts = await sender.send([message('tok-1'), message('tok-2')]);

    // The contract on PushSender.send. A dead push channel is an ordinary
    // Tuesday and must not be able to take out the sweep that calls it.
    expect(receipts).toHaveLength(2);
    expect(receipts.every((r) => !r.ok && r.reason === 'transport')).toBe(true);
    expect(receipts[0]?.detail).toContain('ENOTFOUND');
  });

  it('does not throw when the deadline expires', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    const [receipt] = await sender.send([message('tok-1')]);

    expect(receipt?.reason).toBe('transport');
    expect(receipt?.detail).toContain('TimeoutError');
  });

  it('blames our credentials, not the devices, when Expo refuses the whole request', async () => {
    fetchMock.mockResolvedValue(ok({}, 401));

    const receipts = await sender.send([message('tok-1'), message('tok-2')]);

    // The failure mode this rules out: an auth error looking like every device
    // in the estate deregistering at once, and the next sweep having no one
    // left to notify.
    expect(receipts.every((r) => r.reason === 'invalid_credentials')).toBe(true);
    expect(receipts.every((r) => r.reason !== 'device_not_registered')).toBe(true);
  });

  it('treats a 500 as transport, which also deletes nothing', async () => {
    fetchMock.mockResolvedValue(ok({}, 503));

    const [receipt] = await sender.send([message('tok-1')]);

    expect(receipt?.reason).toBe('transport');
    expect(receipt?.detail).toBe('HTTP 503');
  });

  it('refuses to guess when the ticket count does not match the batch', async () => {
    fetchMock.mockResolvedValue(ok({ data: [{ status: 'ok' }] }));

    const receipts = await sender.send([message('tok-1'), message('tok-2')]);

    // Expo correlates tickets by position and offers nothing else, so a short
    // array means we cannot say which device each ticket is about. Lining them
    // up anyway would delete the wrong person's registration.
    expect(receipts).toHaveLength(2);
    expect(receipts.every((r) => !r.ok && r.reason === 'unknown')).toBe(true);
  });

  it('splits a batch larger than the provider accepts, and still answers once per message', async () => {
    const messages = Array.from({ length: PUSH_BATCH_SIZE + 1 }, (_, i) =>
      message(`tok-${String(i)}`),
    );

    fetchMock.mockImplementation((_url, init) => {
      const sent = JSON.parse(init.body as string) as unknown[];

      return Promise.resolve(ok({ data: sent.map(() => ({ status: 'ok' })) }));
    });

    const receipts = await sender.send(messages);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(receipts).toHaveLength(PUSH_BATCH_SIZE + 1);
    expect(receipts.map((r) => r.token)).toEqual(messages.map((m) => m.token));
  });

  it('does not call the provider at all for an empty batch', async () => {
    expect(await sender.send([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
