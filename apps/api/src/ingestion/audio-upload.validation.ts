import { MAX_AUDIO_UPLOAD_BYTES } from '@adhd/shared';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * What multer hands the controller. Declared structurally rather than as
 * `Express.Multer.File` so the checks below can be unit-tested without
 * building a full multer file object.
 */
export interface UploadedAudio {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Rejects anything that is not an audio upload within the size cap.
 *
 * Multer's own `limits.fileSize` truncates silently at the limit rather than
 * failing, so size is re-checked here where it can be turned into a 413. The
 * type check reads the declared content type, which the client controls — it
 * is a cheap filter that keeps obvious mistakes out of the bucket, not a
 * security boundary. The worker in Milestone B is what will find out whether
 * the bytes actually decode as audio.
 *
 * The 25 MB cap is this project's choice: docs/adhd_tracker.md specifies no
 * limit for media uploads. At Whisper-typical bitrates it is roughly three
 * hours of speech, comfortably past any plausible voice memo.
 */
export function assertUploadableAudio(file: UploadedAudio | undefined): asserts file is UploadedAudio {
  if (file === undefined) {
    throw new BadRequestException('An audio file is required in the "file" field');
  }

  if (!/^audio\//i.test(file.mimetype)) {
    throw new BadRequestException(`Unsupported content type "${file.mimetype}"; expected audio/*`);
  }

  if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
    throw new PayloadTooLargeException(
      `Audio uploads are limited to ${String(MAX_AUDIO_UPLOAD_BYTES)} bytes`,
    );
  }
}

/**
 * The storage key for one upload: `{userId}/{uuid}.webm`.
 *
 * User-prefixed so a listing is scoped by prefix and a stray key cannot be
 * mistaken for another user's. The name is a fresh UUID, never anything the
 * client sent: an uploaded filename is attacker-controlled and has no business
 * shaping a path.
 */
export function audioObjectKey(userId: string): string {
  return `${userId}/${randomUUID()}.webm`;
}
