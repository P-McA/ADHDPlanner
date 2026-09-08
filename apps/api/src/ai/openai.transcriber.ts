import { TRANSCRIPTION_TIMEOUT_MS } from '@adhd/shared';
import { Injectable, Logger } from '@nestjs/common';

import type { Transcriber } from './ai.ports.js';
import { openAiKey, OPENAI_BASE_URL } from './openai.config.js';

const TRANSCRIPTION_URL = `${OPENAI_BASE_URL}/audio/transcriptions`;
const MODEL = 'whisper-1';

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
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimetype }), 'memo.webm');
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
      throw new Error(`Whisper returned ${response.status}: ${await errorText(response)}`);
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
