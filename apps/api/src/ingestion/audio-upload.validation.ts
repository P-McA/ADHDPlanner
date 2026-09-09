import { AUDIO_UPLOAD_FIELD, MAX_AUDIO_UPLOAD_BYTES } from '@adhd/shared';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * What multer hands the controller. Declared structurally rather than as
 * `Express.Multer.File` so the checks below can be unit-tested without
 * building a full multer file object.
 */
export interface UploadedAudio {
  /** The multipart field this part arrived under. See {@link selectAudioUpload}. */
  fieldname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Picks the audio part out of everything multipart handed us, and says
 * precisely what is wrong when it is not there.
 *
 * This exists because of the failure it replaces. The route used to take
 * `FileInterceptor('file')`, and multer's `single()` rejects a file arriving
 * under any other name with `Unexpected field` — no mention of which field was
 * unexpected, which field was wanted, or that the two are the same mistake.
 * A client author reading that has to guess, and the browser client cost us
 * exactly that guess once already. Accepting every part and choosing here
 * means the 400 can name both sides:
 *
 *     Expected the audio in a multipart field named "file", but the request
 *     sent it as "audio".
 *
 * The contract is not loosened by this. A part named anything but
 * {@link AUDIO_UPLOAD_FIELD} is still refused — it is refused *legibly*.
 */
export function selectAudioUpload(files: UploadedAudio[] | undefined): UploadedAudio | undefined {
  const parts = files ?? [];
  const audio = parts.find((part) => part.fieldname === AUDIO_UPLOAD_FIELD);

  if (audio !== undefined) return audio;

  if (parts.length === 0) return undefined;

  const sent = parts.map((part) => `"${part.fieldname}"`).join(', ');

  throw new BadRequestException(
    `Expected the audio in a multipart field named "${AUDIO_UPLOAD_FIELD}", ` +
      `but the request sent it as ${sent}`,
  );
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
    throw new BadRequestException(
      `An audio file is required, sent as multipart field "${AUDIO_UPLOAD_FIELD}"`,
    );
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
