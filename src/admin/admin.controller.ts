import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { toCsv } from '../common/csv';
import { CurrentUser } from '../decorators/current-user.decorator';
import { GroupRole } from '../decorators/group-role.decorator';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import { PaymentAccountsService } from '../platform/payment-accounts.service';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { AdminDeletionService } from './admin-deletion.service';
import { JobQueueService } from '../jobs/job-queue.service';
import { AdminGroupsService } from './admin-groups.service';
import { AdminUsersService } from './admin-users.service';
import {
  AdminGroupsQueryDto,
  AdminUsersQueryDto,
  AuditQueryDto,
  DeletionDecisionDto,
  DeletionQueryDto,
  DeletionRejectDto,
  PaymentAccountDto,
  PlatformSettingsDto,
  ResetAccessDto,
  SuspendUserDto,
} from './dto/admin.dto';

@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@Roles(RoleName.SUPER_ADMIN)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly svc: AdminUsersService) {}

  @Get()
  @ApiOperation({ summary: 'Super admin: search users (status, role, text)' })
  list(@Query() q: AdminUsersQueryDto) {
    return this.svc.list(q);
  }

  @Get(':id')
  @ApiParam({ name: 'id' })
  detail(@Param('id') id: string) {
    return this.svc.detail(id);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspend an account (ends every session, blocks sign-in)',
  })
  suspend(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SuspendUserDto,
  ) {
    return this.svc.suspend(actor, id, dto.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  reactivate(@CurrentUser() actor: AuthenticatedUser, @Param('id') id: string) {
    return this.svc.reactivate(actor, id);
  }

  @Post(':id/unlock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear a failed-login lockout' })
  unlock(@Param('id') id: string) {
    return this.svc.unlock(id);
  }

  @Post(':id/reset-access')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sign the user out everywhere, clear lockout, optionally email a reset code',
  })
  resetAccess(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResetAccessDto,
  ) {
    return this.svc.resetAccess(actor, id, dto.sendResetEmail ?? true);
  }

  @Post(':id/resend-verification')
  @HttpCode(HttpStatus.OK)
  resendVerification(@Param('id') id: string) {
    return this.svc.resendVerification(id);
  }

  @Post(':id/verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark the email verified (support override)' })
  verifyEmail(@Param('id') id: string) {
    return this.svc.verifyEmail(id);
  }

  @Post(':id/impersonate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Read-only 30-minute session as this user (support)',
  })
  impersonate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.svc.impersonate(actor, id);
  }
}

@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@Roles(RoleName.SUPER_ADMIN)
@Controller('admin/groups')
export class AdminGroupsController {
  constructor(
    private readonly svc: AdminGroupsService,
    private readonly accounts: PaymentAccountsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Super admin: all groups with verification, size and balances',
  })
  list(@Query() q: AdminGroupsQueryDto) {
    return this.svc.list(q);
  }

  @Get(':groupId')
  detail(@Param('groupId') groupId: string) {
    return this.svc.detail(groupId);
  }

  @Put(':groupId/payment-account')
  @ApiOperation({
    summary: "Set the group's own MTN MoMo account (secrets are write-only)",
  })
  upsertPaymentAccount(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Body() dto: PaymentAccountDto,
  ) {
    return this.accounts.upsert(actor.id, groupId, dto);
  }

  @Delete(':groupId/payment-account')
  removePaymentAccount(@Param('groupId') groupId: string) {
    return this.accounts.remove(groupId);
  }
}

function auditCsv(rows: Awaited<ReturnType<AuditService['exportRows']>>) {
  return toCsv(
    [
      'Time (UTC)',
      'Action',
      'Actor',
      'Actor id',
      'Impersonated by',
      'Entity',
      'Entity id',
      'Group id',
      'Before',
      'After',
      'IP',
      'Status',
      'Path',
    ],
    rows.map((r) => [
      r.createdAt.toISOString(),
      r.action,
      r.actorName ?? '',
      r.actorId ?? '',
      r.impersonatorId ?? '',
      r.entityType ?? '',
      r.entityId ?? '',
      r.groupId ?? '',
      r.before ? JSON.stringify(r.before) : '',
      r.after ? JSON.stringify(r.after) : '',
      r.ip ?? '',
      r.statusCode ?? '',
      `${r.method ?? ''} ${r.path ?? ''}`.trim(),
    ]),
  );
}

function csvFile(buffer: Buffer, name: string) {
  return new StreamableFile(buffer, {
    type: 'text/csv; charset=utf-8',
    disposition: `attachment; filename="${name}"`,
    length: buffer.length,
  });
}

@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@Controller()
export class AuditLogController {
  constructor(private readonly audit: AuditService) {}

  @Get('admin/audit-logs')
  @Roles(RoleName.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Super admin: platform-wide audit log (json or csv)',
  })
  async platform(@Query() q: AuditQueryDto) {
    if (q.format === 'csv') {
      return csvFile(
        auditCsv(await this.audit.exportRows(q)),
        `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      );
    }
    return this.audit.list(q);
  }

  @Get('admin/audit-logs/actions')
  @Roles(RoleName.SUPER_ADMIN)
  actions() {
    return this.audit.actions();
  }

  @Get('groups/:groupId/audit-log')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({
    summary: 'Group leaders: audit log of this group (json or csv)',
  })
  async group(@Param('groupId') groupId: string, @Query() q: AuditQueryDto) {
    const scoped = { ...q, groupId };
    if (q.format === 'csv') {
      return csvFile(
        auditCsv(await this.audit.exportRows(scoped)),
        `group-audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      );
    }
    return this.audit.list(scoped);
  }
}

@ApiTags('admin')
@Controller()
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get('platform/settings')
  @Public()
  @ApiOperation({
    summary: 'Public platform settings (currencies, sign-ups, MoMo fee)',
  })
  publicSettings() {
    return this.settings.publicView();
  }

  @Get('admin/platform-settings')
  @ApiBearerAuth('JWT-auth')
  @Roles(RoleName.SUPER_ADMIN)
  async get() {
    return this.settings.view(await this.settings.get());
  }

  @Put('admin/platform-settings')
  @ApiBearerAuth('JWT-auth')
  @Roles(RoleName.SUPER_ADMIN)
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: PlatformSettingsDto,
  ) {
    return this.settings.update(actor.id, dto);
  }
}

@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@Roles(RoleName.SUPER_ADMIN)
@Controller('admin/deletion-requests')
export class AdminDeletionController {
  constructor(private readonly svc: AdminDeletionService) {}

  @Get()
  @ApiOperation({
    summary: 'Super admin: account deletion requests (answer within 30 days)',
  })
  list(@Query() q: DeletionQueryDto) {
    return this.svc.list(q.status);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Anonymise the account (refused while it still has group money ties)',
  })
  approve(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeletionDecisionDto,
  ) {
    return this.svc.approve(actor.id, id, dto.note);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: DeletionRejectDto,
  ) {
    return this.svc.reject(actor.id, id, dto.note);
  }
}

@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@Roles(RoleName.SUPER_ADMIN)
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(private readonly queue: JobQueueService) {}

  @Get()
  @ApiOperation({
    summary: 'Super admin: background job queue (backlog, failures)',
  })
  summary() {
    return this.queue.summary();
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  retry(@Param('id') id: string) {
    return this.queue.retry(id);
  }
}
