import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { AdminDeletionService } from './admin-deletion.service';
import { AdminGroupsService } from './admin-groups.service';
import { AdminUsersService } from './admin-users.service';
import {
  AdminDeletionController,
  AdminJobsController,
  AdminGroupsController,
  AdminUsersController,
  AuditLogController,
  PlatformSettingsController,
} from './admin.controller';

/** Super-admin tools (msfts §6). */
@Module({
  imports: [AuthModule, UsersModule, NotificationsModule],
  controllers: [
    AdminUsersController,
    AdminGroupsController,
    AuditLogController,
    PlatformSettingsController,
    AdminDeletionController,
    AdminJobsController,
  ],
  providers: [AdminUsersService, AdminGroupsService, AdminDeletionService],
})
export class AdminModule {}
