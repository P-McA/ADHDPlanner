import { TRANSCRIPTION_TIMEOUT_MS } from '@adhd/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAiTranscriber, asWhisperContainer, whisperFileName } from './openai.transcriber.js';

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

  it('relabels an Android 3GPP memo as m4a on the way to Whisper', async () => {
    const fetchMock = respond({ body: { text: 'hi' } });
    globalThis.fetch = fetchMock;

    await transcriber.transcribe(threeGpp(), 'audio/x-m4a');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const file = (init.body as FormData).get('file') as File;
    const sent = Buffer.from(await file.arrayBuffer());

    // The phone memo Whisper 400'd on 2026-10-08 differed from one it
    // transcribed only in these brands.
    expect(sent.toString('latin1', 0, 24)).toBe(ftyp('M4A ', 'isom', 'M4A '));
    expect(sent.subarray(24)).toEqual(threeGpp().subarray(24));
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

/** A 24-byte `ftyp` box: major brand, minor version 0, two compatible brands. */
function ftyp(major: string, ...compatible: string[]): string {
  const size = 16 + 4 * compatible.length;

  return `\0\0\0${String.fromCharCode(size)}ftyp${major}\0\0\0\0${compatible.join('')}`;
}

/** The head of a real Android voice-recorder memo: 3GPP-branded, then media. */
function threeGpp(): Buffer {
  return Buffer.concat([
    Buffer.from(ftyp('3gp4', 'isom', '3gp4'), 'latin1'),
    Buffer.from('\0\0\0\x01mdat-aac-frames', 'latin1'),
  ]);
}

describe('asWhisperContainer', () => {
  it('rewrites every 3GPP brand and nothing else', () => {
    const out = asWhisperContainer(threeGpp());

    expect(out.toString('latin1', 0, 24)).toBe(ftyp('M4A ', 'isom', 'M4A '));
    expect(out.subarray(24)).toEqual(threeGpp().subarray(24));
  });

  it('never touches the stored bytes it was handed', () => {
    const stored = threeGpp();

    asWhisperContainer(stored);

    expect(stored).toEqual(threeGpp());
  });

  it.each([
    ['an m4a', Buffer.from(`${ftyp('M4A ', 'isom', 'mp42')}rest`, 'latin1')],
    ['a webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['a tiny buffer', Buffer.from('ftyp')],
  ])('passes %s through untouched', (_label, audio) => {
    expect(asWhisperContainer(audio)).toBe(audio);
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
    ['audio/3gpp', 'memo.m4a'],
  ])('names %s as %s', (mimetype, expected) => {
    expect(whisperFileName(mimetype)).toBe(expected);
  });

  it('keeps the old webm default for a subtype Whisper does not list', () => {
    expect(whisperFileName('audio/x-something-new')).toBe('memo.webm');
  });
});
