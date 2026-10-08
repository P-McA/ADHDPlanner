import { Module } from '@nestjs/common';

import { DECOMPOSER, EXTRACTOR, TRANSCRIBER } from './ai.ports.js';
import { OpenAiDecomposer } from './openai.decomposer.js';
import { OpenAiExtractor } from './openai.extractor.js';
import { OpenAiTranscriber } from './openai.transcriber.js';

/**
 * The provider boundary, bound to tokens.
 *
 * Consumers inject `TRANSCRIBER`/`EXTRACTOR`, never the OpenAI classes, which
 * is what lets the e2e suite override these two tokens with fixture-backed
 * fakes and keeps every OpenAI URL inside the two adapter files.
 */
@Module({
  providers: [
    { provide: TRANSCRIBER, useClass: OpenAiTranscriber },
    { provide: EXTRACTOR, useClass: OpenAiExtractor },
    { provide: DECOMPOSER, useClass: OpenAiDecomposer },
  ],
  exports: [TRANSCRIBER, EXTRACTOR, DECOMPOSER],
})
export class AiModule {}
