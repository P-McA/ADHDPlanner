import type { Task } from '@adhd/shared';
import { Controller, Post, UseGuards } from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/clerk-auth.guard.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { PredictionsService } from './predictions.service.js';

@Controller('predictions')
@UseGuards(ClerkAuthGuard)
export class PredictionsController {
  constructor(private readonly predictions: PredictionsService) {}

  /**
   * "Suggest tasks". 201 with the drafts it created — possibly none, when
   * there is not yet enough history to learn from. 409 while earlier
   * suggestions are unreviewed; 502 when the embedding model fails, with
   * nothing written.
   */
  @Post()
  predict(@CurrentUser() user: AuthenticatedUser): Promise<Task[]> {
    return this.predictions.predict(user.id);
  }
}
