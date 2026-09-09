import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module.js';
import { ExpoPushSender } from './expo-push.sender.js';
import { NotificationsController } from './notifications.controller.js';
import { PUSH_SENDER } from './notifications.ports.js';
import { NotificationsService } from './notifications.service.js';
import { PushTokensService } from './push-tokens.service.js';
import { ReminderWorker } from './reminder.worker.js';

/**
 * Reminders: registration, the sweep, and the provider boundary bound to its
 * token.
 *
 * Consumers inject `PUSH_SENDER`, never `ExpoPushSender`, which is what lets
 * the e2e suite override the token with a fake and keeps every `exp.host` URL
 * inside the one adapter file — the same arrangement as `AiModule`.
 *
 * `UsersModule` is imported for `ClerkAuthGuard`, which the controller uses.
 */
@Module({
  imports: [UsersModule],
  controllers: [NotificationsController],
  providers: [
    PushTokensService,
    NotificationsService,
    ReminderWorker,
    { provide: PUSH_SENDER, useClass: ExpoPushSender },
  ],
  // Exported so the e2e suite can run a sweep by hand, with the scheduler
  // switched off — see ReminderWorker.
  exports: [NotificationsService, PushTokensService],
})
export class NotificationsModule {}
