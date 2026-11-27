import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AnnouncementsService } from './announcements.service';
import {
  AnnouncementsController,
  NotificationSettingsController,
  SmsLogController,
} from './communication.controller';
import { NotificationDeliveryService } from './delivery.service';
import { NotificationsService } from './notifications.service';
import { NotificationPreferencesService } from './preferences.service';
import { PushService } from './push.service';
import { SmsService } from './sms.service';
import { UserNotificationsController } from './user-notifications.controller';

@Module({
  imports: [PrismaModule],
  controllers: [
    UserNotificationsController,
    NotificationSettingsController,
    AnnouncementsController,
    SmsLogController,
  ],
  providers: [
    NotificationsService,
    NotificationDeliveryService,
    SmsService,
    PushService,
    NotificationPreferencesService,
    AnnouncementsService,
  ],
  exports: [NotificationsService, SmsService],
})
export class NotificationsModule {}
