import { Platform } from 'react-native';

import { recordingFileName, recordingMimeType, toUploadPart } from './audio-part';

/**
 * The web/native split that caused "Upload failed" on Expo web. Platform.OS is
 * switched per test; jest-expo's default is ios.
 */

const setPlatform = (os: typeof Platform.OS): void => {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
};

const realFetch = globalThis.fetch;

afterEach(() => {
  setPlatform('ios');
  globalThis.fetch = realFetch;
});

describe('toUploadPart', () => {
  const file = { uri: 'file:///cache/memo.m4a', name: 'memo.m4a', type: 'audio/mp4' };

  it('hands native the {uri,name,type} part its FormData reads off disk', async () => {
    setPlatform('ios');

    await expect(toUploadPart(file)).resolves.toEqual(file);
  });

  it('hands the browser a real Blob, which is all its FormData accepts', async () => {
    setPlatform('web');
    const bytes = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({ blob: () => Promise.resolve(bytes) } as Response),
    );

    const part = await toUploadPart({
      uri: 'blob:http://localhost:8081/x',
      name: 'n.webm',
      type: 'audio/webm',
    });

    expect(part).toBeInstanceOf(Blob);
    // The point of the fix: the browser's FormData takes it without throwing.
    expect(() => {
      new FormData().append('file', part as Blob, 'n.webm');
    }).not.toThrow();
  });

  it('uses the File the web picker already has, without fetching', async () => {
    setPlatform('web');
    const picked = new Blob([new Uint8Array([9])], { type: 'audio/mpeg' });
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    await expect(toUploadPart({ ...file, file: picked })).resolves.toBe(picked);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the declared type when the browser returns an untyped blob', async () => {
    setPlatform('web');
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        blob: () => Promise.resolve(new Blob([new Uint8Array([1])])),
      } as Response),
    );

    const part = await toUploadPart({ uri: 'blob:x', name: 'n', type: 'audio/webm' });

    // Blob first: the {uri,name,type} object also has `type: 'audio/webm'`, so
    // the type check alone passes against the very bug this file fixes.
    expect(part).toBeInstanceOf(Blob);
    expect(part.type).toBe('audio/webm');
  });
});

describe('recordingMimeType', () => {
  it.each([
    ['file:///cache/Audio/rec.m4a', 'audio/mp4'],
    ['file:///cache/rec.M4A', 'audio/mp4'],
    ['file:///cache/rec.3gp', 'audio/3gpp'],
    ['file:///cache/rec.webm', 'audio/webm'],
  ])('reads %s as %s', (uri, expected) => {
    expect(recordingMimeType(uri)).toBe(expected);
  });

  it('treats an extensionless web blob URL as webm', () => {
    setPlatform('web');

    expect(recordingMimeType('blob:http://localhost:8081/1f2e')).toBe('audio/webm');
  });
});

describe('recordingFileName', () => {
  const at = new Date('2026-10-07T18:30:05.123Z');

  it('names an m4a as .m4a and a webm as .webm', () => {
    expect(recordingFileName('audio/mp4', at)).toBe('voice-note-2026-10-07T18-30-05-123Z.m4a');
    expect(recordingFileName('audio/webm', at)).toBe('voice-note-2026-10-07T18-30-05-123Z.webm');
  });
});
