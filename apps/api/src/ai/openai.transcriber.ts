import { TRANSCRIPTION_TIMEOUT_MS } from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';

import type { Transcriber } from './ai.ports.js';
import { openAiKey, OPENAI_BASE_URL } from './openai.config.js';
import { ProviderError } from './provider-error.js';

const TRANSCRIPTION_URL = `${OPENAI_BASE_URL}/audio/transcriptions`;
const MODEL = 'whisper-1';

/**
 * Whisper's accepted containers, keyed by the audio/* subtype we may be handed.
 * Phones record AAC in MP4 (`audio/mp4`, `.m4a`), browsers record webm, and a
 * picked file can be almost anything on Whisper's list.
 */
const EXTENSION_FOR_SUBTYPE: Record<string, string> = {
  webm: 'webm',
  mp4: 'm4a',
  m4a: 'm4a',
  'x-m4a': 'm4a',
  aac: 'm4a',
  // Android's voice recorders write 3GPP; once `asWhisperContainer` has
  // relabelled the brand it is an m4a in every way Whisper checks.
  '3gpp': 'm4a',
  mpeg: 'mp3',
  mp3: 'mp3',
  mpga: 'mpga',
  wav: 'wav',
  'x-wav': 'wav',
  wave: 'wav',
  ogg: 'ogg',
  oga: 'oga',
  flac: 'flac',
  'x-flac': 'flac',
};

/**
 * The filename to give Whisper for a memo of this content type.
 *
 * Whisper's documented format detection is the filename extension. Measured
 * on 2026-10-07 it also sniffs at least WAV correctly when misnamed, so the
 * old fixed `memo.webm` was not *proved* to break any format — but it told
 * the provider something false about every non-webm memo, and the phone's own
 * recorder produces m4a. Parameters (`;codecs=opus`) are ignored; an unknown
 * subtype keeps the old `webm` default rather than inventing an extension.
 */
export function whisperFileName(mimetype: string): string {
  const subtype = /^audio\/([^;\s]+)/i.exec(mimetype.trim())?.[1]?.toLowerCase() ?? '';

  return `memo.${EXTENSION_FOR_SUBTYPE[subtype] ?? 'webm'}`;
}

/** The ISO-BMFF brand Whisper accepts for AAC audio. */
const M4A_BRAND = 'M4A ';

/**
 * The memo's bytes, with a 3GPP container relabelled as M4A.
 *
 * Android voice recorders store AAC in a file whose `ftyp` box says `3gp4`.
 * Whisper reads that brand and answers 400 "Invalid file format" even though
 * the audio inside is the AAC it accepts in an `.m4a`. Measured on 2026-10-08
 * against a real phone memo: the untouched bytes 400, and the same bytes with
 * only the brands rewritten transcribe correctly. The boxes are byte-for-byte
 * the same layout, so rewriting the four-byte brands is a relabel, not a
 * transcode. Anything that is not a 3GPP-branded file comes back unchanged —
 * the same Buffer — and the stored object is never modified.
 */
export function asWhisperContainer(audio: Buffer): Buffer {
  if (audio.length < 16 || audio.toString('latin1', 4, 8) !== 'ftyp') {
    return audio;
  }

  const boxEnd = Math.min(audio.readUInt32BE(0), audio.length);

  if (!audio.toString('latin1', 8, 12).startsWith('3gp')) {
    return audio;
  }

  const relabelled = Buffer.from(audio);

  // Major brand at 8, minor version at 12, compatible brands from 16 on.
  for (let at = 8; at + 4 <= boxEnd; at += at === 8 ? 8 : 4) {
    if (relabelled.toString('latin1', at, at + 4).startsWith('3gp')) {
      relabelled.write(M4A_BRAND, at, 'latin1');
    }
  }

  return relabelled;
}

/**
 * Whisper over plain fetch.
 *
 * No SDK: this is one multipart POST, and Node 24 has everything it needs. The
 * cost of a vendor SDK here would be a dependency, its transitive tree and its
 * own retry policy fighting BullMQ's, in exchange for typing a URL for us.
 */
@Injectable()
export class OpenAiTranscriber implements Transcriber {
  private readonly logger = new Logger(OpenAiTranscriber.name);

  async transcribe(audio: Buffer, mimetype: string): Promise<string> {
    const form = new FormData();

    // Whisper reads the container format from the filename extension, so the
    // name is load-bearing despite never being stored anywhere.
    form.append(
      'file',
      new Blob([new Uint8Array(asWhisperContainer(audio))], { type: mimetype }),
      whisperFileName(mimetype),
    );
    form.append('model', MODEL);
    form.append('response_format', 'json');

    const response = await fetch(TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${openAiKey()}` },
      body: form,
      // A hung provider must not become a worker that never returns: the job
      // has to end in `failed` with a reason rather than a memo stuck on
      // `transcribing` forever. Transcription gets the longer budget because it
      // scales with the length of the audio.
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw ProviderError.fromStatus(
        `Whisper returned ${response.status}: ${await errorText(response)}`,
        response.status,
      );
    }

    const body = (await response.json()) as { text?: unknown };

    if (typeof body.text !== 'string') {
      throw new Error('Whisper returned no text field');
    }

    this.logger.debug(`Transcribed ${audio.byteLength} bytes to ${body.text.length} characters`);

    return body.text.trim();
  }
}

/** The provider's error body, truncated — it can be an HTML error page. */
async function errorText(response: Response): Promise<string> {
  return (await response.text().catch(() => '<unreadable>')).slice(0, 300);
}
