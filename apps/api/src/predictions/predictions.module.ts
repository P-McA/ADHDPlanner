import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module.js';
import { UsersModule } from '../users/users.module.js';
import { PredictionsController } from './predictions.controller.js';
import { PredictionsService } from './predictions.service.js';

/** Imports UsersModule for ClerkAuthGuard, like every guarded module. */
@Module({
  imports: [UsersModule, AiModule],
  controllers: [PredictionsController],
  providers: [PredictionsService],
})
export class PredictionsModule {}
