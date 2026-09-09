import { AUDIO_UPLOAD_FIELD, MAX_AUDIO_UPLOAD_BYTES } from '@adhd/shared';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  assertUploadableAudio,
  audioObjectKey,
  selectAudioUpload,
  type UploadedAudio,
} from './audio-upload.validation.js';

/**
 * The gate in front of object storage. Everything here is about what must
 * *not* reach the bucket, and about the key never being caller-controlled.
 */

const upload = (over: Partial<UploadedAudio> = {}): UploadedAudio => ({
  fieldname: AUDIO_UPLOAD_FIELD,
  mimetype: 'audio/webm',
  size: 1024,
  buffer: Buffer.from('fake audio'),
  ...over,
});

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('assertUploadableAudio', () => {
  it('accepts an ordinary audio upload', () => {
    expect(() => {
      assertUploadableAudio(upload());
    }).not.toThrow();
  });

  it('rejects a missing file with 400 rather than storing nothing silently', () => {
    expect(() => {
      assertUploadableAudio(undefined);
    }).toThrow(BadRequestException);
  });

  it.each([
    ['a PDF renamed as an upload', 'application/pdf'],
    ['an image', 'image/png'],
    ['plain text', 'text/plain'],
    // Not audio/*: a leading match is not enough, the type must start with it.
    ['something merely containing "audio"', 'application/x-audio-ish'],
    ['a video, which is close but not in scope this milestone', 'video/webm'],
  ])('rejects %s', (_label, mimetype) => {
    expect(() => {
      assertUploadableAudio(upload({ mimetype }));
    }).toThrow(BadRequestException);
  });

  it.each([
    ['audio/webm', 'audio/webm'],
    ['audio/mpeg', 'audio/mpeg'],
    ['audio/mp4', 'audio/mp4'],
    ['audio/ogg with codecs', 'audio/ogg; codecs=opus'],
    // Content types are case-insensitive per RFC 9110.
    ['an upper-case type', 'AUDIO/WEBM'],
  ])('accepts %s', (_label, mimetype) => {
    expect(() => {
      assertUploadableAudio(upload({ mimetype }));
    }).not.toThrow();
  });

  it('accepts a file exactly at the cap', () => {
    expect(() => {
      assertUploadableAudio(upload({ size: MAX_AUDIO_UPLOAD_BYTES }));
    }).not.toThrow();
  });

  it('rejects one byte over the cap with 413, not 400', () => {
    // The distinction matters to a client deciding whether to re-encode and
    // retry or to give up: 413 is "too big", 400 is "wrong shape".
    expect(() => {
      assertUploadableAudio(upload({ size: MAX_AUDIO_UPLOAD_BYTES + 1 }));
    }).toThrow(PayloadTooLargeException);
  });

  it('caps at 25 MB', () => {
    expect(MAX_AUDIO_UPLOAD_BYTES).toBe(26_214_400);
  });
});

describe('audioObjectKey', () => {
  it('prefixes the key with the owning user', () => {
    expect(audioObjectKey(USER_ID)).toMatch(
      /^11111111-1111-1111-1111-111111111111\/[0-9a-f-]{36}\.webm$/,
    );
  });

  it('never reuses a key', () => {
    const keys = new Set(Array.from({ length: 100 }, () => audioObjectKey(USER_ID)));

    // A collision would overwrite someone's memo with someone else's.
    expect(keys.size).toBe(100);
  });
});

/**
 * The field-name selector.
 *
 * These are the tests for a diagnosis rather than a rule: every case below was
 * already rejected before, just unintelligibly. What is pinned is that the
 * message names the field we wanted *and* the field that turned up, because a
 * client author who cannot see the server has nothing else to go on.
 */
describe('selectAudioUpload', () => {
  it('takes the part sent under the documented field name', () => {
    const audio = upload();

    expect(selectAudioUpload([audio])).toBe(audio);
  });

  it('returns nothing when no part was sent at all, leaving the "required" answer to the caller', () => {
    expect(selectAudioUpload([])).toBeUndefined();
    expect(selectAudioUpload(undefined)).toBeUndefined();
  });

  it('names both the expected field and the one the request used', () => {
    let thrown: unknown;

    try {
      selectAudioUpload([upload({ fieldname: 'audio' })]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    // Both halves, deliberately: "expected file" alone does not tell the
    // author their part was named something, and "sent audio" alone does not
    // tell them what to rename it to.
    expect((thrown as BadRequestException).message).toContain(`"${AUDIO_UPLOAD_FIELD}"`);
    expect((thrown as BadRequestException).message).toContain('"audio"');
  });

  it('lists every field it did receive, so a two-part form is diagnosable too', () => {
    expect(() => selectAudioUpload([upload({ fieldname: 'memo' }), upload({ fieldname: 'blob' })]))
      .toThrow(/"memo", "blob"/);
  });

  it('still finds the audio when it is not the first part', () => {
    const audio = upload();

    expect(selectAudioUpload([upload({ fieldname: 'notes' }), audio])).toBe(audio);
  });
});
