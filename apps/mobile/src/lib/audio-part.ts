import { Platform } from 'react-native';

import type { AudioPart } from './api-client';

/**
 * Turns a file the app holds — picked or just recorded — into the part
 * `uploadVoiceMemo` can actually send on *this* platform.
 *
 * The two runtimes disagree about what a file part is. React Native's native
 * `FormData` takes `{ uri, name, type }` and reads the bytes off disk itself.
 * The browser's `FormData` (Expo web) only accepts a real `Blob`, and throws
 * `TypeError: parameter 2 is not of type 'Blob'` on the object — synchronously,
 * before any request exists. That throw was the "Upload failed" on web: it is
 * not an `ApiError`, because nothing ever reached the API.
 *
 * Kept out of `api-client.ts` on purpose: that module must not import React
 * Native, because the API's e2e suite imports it and runs it under Node.
 */
export async function toUploadPart(file: {
  uri: string;
  name: string;
  type: string;
  /** The web picker hands over the `File` itself; use it when there is one. */
  file?: Blob;
}): Promise<AudioPart | Blob> {
  if (Platform.OS !== 'web') return { uri: file.uri, name: file.name, type: file.type };

  if (file.file !== undefined) return file.file;

  // A recording on web is a `blob:` URL owned by this page. Fetching it is how
  // you get the bytes back out; it never leaves the browser.
  const response = await fetch(file.uri);
  const blob = await response.blob();

  // Keep the declared type: some browsers return the blob untyped, and the API
  // refuses anything that is not audio/* with a 400.
  return blob.type === '' ? new Blob([blob], { type: file.type }) : blob;
}

/**
 * The content type for a recording, from the extension the recorder gave it.
 *
 * expo-audio writes `.m4a` (AAC in MP4) on iOS and Android and `.webm` on web.
 * The type matters twice: the API only accepts audio/*, and the transcriber
 * names the file for Whisper from it.
 */
export function recordingMimeType(uri: string): string {
  const extension = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(uri)?.[1]?.toLowerCase();

  switch (extension) {
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case '3gp':
      return 'audio/3gpp';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    default:
      // A web recording is a `blob:` URL with no extension; MediaRecorder in
      // every browser that can run this page produces webm.
      return Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4';
  }
}

/** The filename to send with a recording, matching its content type. */
export function recordingFileName(mimeType: string, now: Date = new Date()): string {
  const extension =
    mimeType === 'audio/webm' ? 'webm' : mimeType === 'audio/mp4' ? 'm4a' : 'audio';
  const stamp = now.toISOString().replace(/[:.]/g, '-');

  return `voice-note-${stamp}.${extension}`;
}
