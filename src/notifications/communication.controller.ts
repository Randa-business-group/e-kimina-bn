import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CurrentUser } from '../decorators/current-user.decorator';
import { GroupRole } from '../decorators/group-role.decorator';
import { Roles } from '../decorators/roles.decorator';
import { AnnouncementsService } from './announcements.service';
import {
  CreateAnnouncementDto,
  PushSubscriptionDto,
  PushUnsubscribeDto,
  SmsLogQueryDto,
  UpdateAnnouncementDto,
  UpdatePreferencesDto,
} from './dto/notifications.dto';
import { NotificationPreferencesService } from './preferences.service';
import { PushService } from './push.service';
import { SmsService } from './sms.service';

@ApiTags('notifications')
@ApiBearerAuth('JWT-auth')
@Controller('users/me')
export class NotificationSettingsController {
  constructor(
    private readonly prefs: NotificationPreferencesService,
    private readonly push: PushService,
  ) {}

  @Get('notification-preferences')
  @ApiOperation({
    summary: 'Channels available to me and my preference per category',
  })
  get(@CurrentUser() u: AuthenticatedUser) {
    return this.prefs.get(u.id);
  }

  @Put('notification-preferences')
  update(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.prefs.update(u.id, dto.preferences);
  }

  @Delete('notification-preferences')
  @ApiOperation({ summary: 'Back to the defaults' })
  reset(@CurrentUser() u: AuthenticatedUser) {
    return this.prefs.reset(u.id);
  }

  @Get('push/public-key')
  @ApiOperation({ summary: 'VAPID public key for PushManager.subscribe' })
  async publicKey() {
    return { publicKey: (await this.push.vapidKeys()).publicKey };
  }

  @Post('push-subscriptions')
  subscribe(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: PushSubscriptionDto,
    @Headers('user-agent') ua?: string,
  ) {
    return this.push.subscribe(u.id, dto, ua);
  }

  @Delete('push-subscriptions')
  unsubscribe(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: PushUnsubscribeDto,
  ) {
    return this.push.unsubscribe(u.id, dto?.endpoint);
  }

  @Post('push-subscriptions/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a test notification to my devices' })
  async test(@CurrentUser() u: AuthenticatedUser) {
    const sent = await this.push.sendToUser(u.id, {
      title: 'E-kimina notifications are on',
      body: 'You will get alerts on this device.',
      url: '/dashboard',
    });
    return { sent };
  }
}

@ApiTags('notifications')
@ApiBearerAuth('JWT-auth')
@Controller('groups/:groupId/announcements')
export class AnnouncementsController {
  constructor(private readonly svc: AnnouncementsService) {}

  @Get()
  @GroupRole(RoleName.MEMBER, RoleName.GROUP_ADMIN, RoleName.TREASURER)
  list(@Param('groupId') groupId: string) {
    return this.svc.list(groupId);
  }

  @Post()
  @GroupRole(RoleName.GROUP_ADMIN)
  @ApiOperation({
    summary:
      'Group admin: announce to every member (in-app + optional email / SMS / push)',
  })
  create(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Body() dto: CreateAnnouncementDto,
  ) {
    return this.svc.create(u.id, groupId, dto);
  }

  @Patch(':announcementId')
  @GroupRole(RoleName.GROUP_ADMIN)
  pin(
    @Param('groupId') groupId: string,
    @Param('announcementId') id: string,
    @Body() dto: UpdateAnnouncementDto,
  ) {
    return this.svc.setPinned(groupId, id, dto.pinned);
  }

  @Delete(':announcementId')
  @GroupRole(RoleName.GROUP_ADMIN)
  remove(
    @Param('groupId') groupId: string,
    @Param('announcementId') id: string,
  ) {
    return this.svc.remove(groupId, id);
  }
}

@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@Roles(RoleName.SUPER_ADMIN)
@Controller('admin/sms-logs')
export class SmsLogController {
  constructor(
    private readonly prefs: NotificationPreferencesService,
    private readonly sms: SmsService,
  ) {}

  @Get('mock-inbox')
  @ApiOperation({
    summary:
      'Development only (SMS_PROVIDER=mock, not production): texts as sent',
  })
  mockInbox(@Query('to') to?: string) {
    if (!this.sms.mockInboxAvailable) throw new NotFoundException();
    return this.sms.mockInbox(to);
  }

  @Get()
  @ApiOperation({
    summary: 'Super admin: every SMS attempt (codes are masked)',
  })
  list(@Query() q: SmsLogQueryDto) {
    return this.prefs.smsLogs(q);
  }
}
