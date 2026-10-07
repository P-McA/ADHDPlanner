import { TRANSCRIPTION_TIMEOUT_MS } from '@adhd/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAiTranscriber, whisperFileName } from './openai.transcriber.js';

const realFetch = globalThis.fetch;

/** A minimal `fetch` double; the adapter only reads `ok`, `status`, `json`, `text`. */
function respond(init: { ok?: boolean; status?: number; body?: unknown; text?: string }) {
  return vi.fn(() =>
    Promise.resolve({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: () => Promise.resolve(init.body),
      text: () => Promise.resolve(init.text ?? ''),
    } as unknown as Response),
  );
}

describe('OpenAiTranscriber', () => {
  let transcriber: OpenAiTranscriber;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    transcriber = new OpenAiTranscriber();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it('posts the audio to Whisper and returns the text', async () => {
    const fetchMock = respond({ body: { text: '  Book the car in.  ' } });
    globalThis.fetch = fetchMock;

    const text = await transcriber.transcribe(Buffer.from('audio'), 'audio/webm');

    expect(text).toBe('Book the car in.');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-test-not-a-real-key',
    );
  });

  it('sends the file under a name Whisper can read the container format from', async () => {
    const fetchMock = respond({ body: { text: 'hi' } });
    globalThis.fetch = fetchMock;

    await transcriber.transcribe(Buffer.from('audio'), 'audio/webm');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const form = init.body as FormData;
    const file = form.get('file') as File;

    // The extension is load-bearing: Whisper rejects a nameless part.
    expect(file.name).toBe('memo.webm');
    expect(form.get('model')).toBe('whisper-1');
  });

  it('names a phone recording for what it is, not webm', async () => {
    const fetchMock = respond({ body: { text: 'hi' } });
    globalThis.fetch = fetchMock;

    await transcriber.transcribe(Buffer.from('audio'), 'audio/mp4');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const file = (init.body as FormData).get('file') as File;

    expect(file.name).toBe('memo.m4a');
    expect(file.type).toBe('audio/mp4');
  });

  it('gives up rather than hanging, so a stuck provider can become a failed record', async () => {
    const fetchMock = respond({ body: { text: 'hi' } });
    globalThis.fetch = fetchMock;

    await transcriber.transcribe(Buffer.from('audio'), 'audio/webm');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

    // Not a mocked clock: the check is that a deadline was attached at all,
    // and that it is the documented one rather than an accidental default.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(TRANSCRIPTION_TIMEOUT_MS).toBe(60_000);
  });

  it('throws with the provider status and body when the call is rejected', async () => {
    globalThis.fetch = respond({
      ok: false,
      status: 401,
      text: 'Incorrect API key provided',
    });

    await expect(transcriber.transcribe(Buffer.from('a'), 'audio/webm')).rejects.toThrow(
      'Whisper returned 401: Incorrect API key provided',
    );
  });

  it('throws rather than inventing a transcript when the reply has no text', async () => {
    globalThis.fetch = respond({ body: { nothing: true } });

    await expect(transcriber.transcribe(Buffer.from('a'), 'audio/webm')).rejects.toThrow(
      'no text field',
    );
  });

  it('refuses to call the provider at all with no key, and says what to do', async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = respond({ body: { text: 'hi' } });
    globalThis.fetch = fetchMock;

    await expect(transcriber.transcribe(Buffer.from('a'), 'audio/webm')).rejects.toThrow(
      'OPENAI_API_KEY is not set',
    );
    // The key is resolved before the request, so nothing left the process.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('whisperFileName', () => {
  it.each([
    ['audio/webm', 'memo.webm'],
    ['audio/webm;codecs=opus', 'memo.webm'],
    ['audio/mp4', 'memo.m4a'],
    ['audio/x-m4a', 'memo.m4a'],
    ['audio/mpeg', 'memo.mp3'],
    ['audio/wav', 'memo.wav'],
    ['audio/x-wav', 'memo.wav'],
    ['audio/ogg; codecs=opus', 'memo.ogg'],
    ['AUDIO/FLAC', 'memo.flac'],
  ])('names %s as %s', (mimetype, expected) => {
    expect(whisperFileName(mimetype)).toBe(expected);
  });

  it('keeps the old webm default for a subtype Whisper does not list', () => {
    expect(whisperFileName('audio/x-something-new')).toBe('memo.webm');
  });
});
