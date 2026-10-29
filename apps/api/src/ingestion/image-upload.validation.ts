import { IMAGE_MIME_TYPES, IMAGE_UPLOAD_FIELD, MAX_IMAGE_UPLOAD_BYTES } from '@adhd/shared';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** What multer hands the controller. Structural, so it is unit-testable. */
export interface UploadedImage {
  fieldname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Picks the image part out of everything multipart handed us.
 *
 * Same rule and same diagnosis as the audio selector: a part under any other
 * name is refused, but the 400 names both the field that arrived and the one
 * wanted, rather than multer's bare `Unexpected field`.
 */
export function selectImageUpload(files: UploadedImage[] | undefined): UploadedImage | undefined {
  const parts = files ?? [];
  const image = parts.find((part) => part.fieldname === IMAGE_UPLOAD_FIELD);

  if (image !== undefined) return image;

  if (parts.length === 0) return undefined;

  const sent = parts.map((part) => `"${part.fieldname}"`).join(', ');

  throw new BadRequestException(
    `Expected the image in a multipart field named "${IMAGE_UPLOAD_FIELD}", ` +
      `but the request sent it as ${sent}`,
  );
}

/**
 * Rejects anything that is not an accepted image within the size cap.
 *
 * The type check reads the declared content type, which the client controls —
 * a cheap filter, not a security boundary. The vision model is what finds out
 * whether the bytes actually decode.
 */
export function assertUploadableImage(
  file: UploadedImage | undefined,
): asserts file is UploadedImage {
  if (file === undefined) {
    throw new BadRequestException(
      `An image file is required, sent as multipart field "${IMAGE_UPLOAD_FIELD}"`,
    );
  }

  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
    throw new BadRequestException(
      `Unsupported content type "${file.mimetype}"; expected one of ${IMAGE_MIME_TYPES.join(', ')}`,
    );
  }

  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new PayloadTooLargeException(
      `Image uploads are limited to ${String(MAX_IMAGE_UPLOAD_BYTES)} bytes`,
    );
  }
}

/**
 * The storage key for one image: `{userId}/{uuid}.{ext}`.
 *
 * User-prefixed like audio, and the extension comes from the allowlisted type,
 * never from the uploaded filename.
 */
export function imageObjectKey(userId: string, mimetype: string): string {
  const extension = mimetype === 'image/png' ? 'png' : mimetype === 'image/webp' ? 'webp' : 'jpg';

  return `${userId}/${randomUUID()}.${extension}`;
}
