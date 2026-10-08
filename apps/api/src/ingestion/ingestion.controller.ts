import {
  type DeleteIngestionResult,
  type IngestionAccepted,
  type IngestionRecord,
  MAX_AUDIO_UPLOAD_BYTES,
} from '@adhd/shared';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';

import type { AuthenticatedUser } from '../auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import {
  assertUploadableAudio,
  selectAudioUpload,
  type UploadedAudio,
} from './audio-upload.validation.js';
import { IngestionService } from './ingestion.service.js';

/**
 * Voice memo intake.
 *
 * Nothing here creates a task. The upload is stored and queued; the worker
 * that reads it produces *drafts* the user confirms. That fence is the whole
 * point of the phase — see CLAUDE.md.
 *
 * Like TasksController, every route takes its user id from the session, so
 * another user's record is unreachable rather than merely checked.
 */
@Controller('ingestion')
@UseGuards(ClerkAuthGuard)
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post('audio')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(
    // Every part, not `FileInterceptor(AUDIO_UPLOAD_FIELD)`. `single()` refuses
    // a file sent under another name with multer's own `Unexpected field`,
    // which names neither the field that arrived nor the one we wanted;
    // `selectAudioUpload` refuses the same request and says both. The rule is
    // identical, the diagnosis is not.
    AnyFilesInterceptor({
      // In memory, then straight to object storage: no temp file on the API
      // host, which would otherwise be a copy of the user's audio left behind
      // on a crash.
      //
      // The limit is one byte over the cap on purpose. Multer truncates at
      // exactly `fileSize` without erroring, so a file capped *at* the limit
      // arrives looking valid; allowing one more byte lets the size check
      // reject it as too large instead of silently storing a truncated memo.
      limits: { fileSize: MAX_AUDIO_UPLOAD_BYTES + 1, files: 1 },
    }),
  )
  async uploadAudio(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFiles() files: UploadedAudio[] | undefined,
  ): Promise<IngestionAccepted> {
    const file = selectAudioUpload(files);

    assertUploadableAudio(file);

    const record = await this.ingestion.acceptAudio(user.id, file);

    // 202, not 201: the bytes are accepted and queued, but the thing the
    // caller actually wants — drafts — does not exist yet.
    return { id: record.id, status: record.status };
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<IngestionRecord[]> {
    return this.ingestion.list(user.id);
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IngestionRecord> {
    const record = await this.ingestion.findOne(user.id, id);

    if (record === null) {
      // 404 rather than 403, matching tasks: ownership and existence stay
      // indistinguishable from outside.
      throw new NotFoundException('Ingestion record not found');
    }

    return record;
  }

  /**
   * Erases a memo — the audio, the transcript, and the drafts nobody confirmed.
   *
   * Idempotent by consequence rather than by special case: deleting an already
   * deleted record re-runs an object deletion that succeeds on a missing key
   * and a `deleteMany` that matches nothing, and keeps the original
   * `deletedAt`. The caller gets the same answer either way.
   */
  /**
   * Runs a failed memo through the pipeline again. 202, like the upload: the
   * run is queued, and its outcome — drafts or another failure — arrives
   * through `GET /ingestion/:id`.
   */
  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<IngestionRecord> {
    return this.ingestion.retry(user.id, id);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DeleteIngestionResult> {
    return this.ingestion.remove(user.id, id);
  }
}
