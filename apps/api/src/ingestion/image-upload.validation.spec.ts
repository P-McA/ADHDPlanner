import { MAX_IMAGE_UPLOAD_BYTES } from '@adhd/shared';
import { describe, expect, it } from 'vitest';

import {
  assertUploadableImage,
  imageObjectKey,
  selectImageUpload,
  type UploadedImage,
} from './image-upload.validation.js';

const file = (over: Partial<UploadedImage> = {}): UploadedImage => ({
  fieldname: 'file',
  mimetype: 'image/png',
  size: 1024,
  buffer: Buffer.alloc(1024, 0x89),
  ...over,
});

describe('selectImageUpload', () => {
  it('picks the part named by the contract', () => {
    expect(selectImageUpload([file()])?.fieldname).toBe('file');
  });

  it('names both fields when the part is misnamed', () => {
    expect(() => selectImageUpload([file({ fieldname: 'photo' })])).toThrow(/"file".*"photo"/);
  });

  it('returns undefined when there is no part at all', () => {
    expect(selectImageUpload([])).toBeUndefined();
    expect(selectImageUpload(undefined)).toBeUndefined();
  });
});

describe('assertUploadableImage', () => {
  it('accepts each allowlisted type', () => {
    for (const mimetype of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(() => assertUploadableImage(file({ mimetype }))).not.toThrow();
    }
  });

  it('refuses anything else', () => {
    expect(() => assertUploadableImage(file({ mimetype: 'image/heic' }))).toThrow(/image\/jpeg/);
    expect(() => assertUploadableImage(file({ mimetype: 'application/pdf' }))).toThrow();
  });

  it('refuses a missing file', () => {
    expect(() => assertUploadableImage(undefined)).toThrow(/required/);
  });

  it('refuses one byte over the cap and accepts exactly at it', () => {
    expect(() => assertUploadableImage(file({ size: MAX_IMAGE_UPLOAD_BYTES + 1 }))).toThrow();
    expect(() => assertUploadableImage(file({ size: MAX_IMAGE_UPLOAD_BYTES }))).not.toThrow();
  });
});

describe('imageObjectKey', () => {
  it('prefixes the user and derives the extension from the type', () => {
    expect(imageObjectKey('u1', 'image/png')).toMatch(/^u1\/[0-9a-f-]+\.png$/);
    expect(imageObjectKey('u1', 'image/webp')).toMatch(/\.webp$/);
    expect(imageObjectKey('u1', 'image/jpeg')).toMatch(/\.jpg$/);
  });
});
