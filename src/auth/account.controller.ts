import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  clientCtx,
  setRefreshCookie,
  wantsTokenInBody,
  type HttpReq,
  type HttpRes,
} from '../common/http-ctx';
import { RateLimit } from '../common/rate-limit';
import { CurrentUser } from '../decorators/current-user.decorator';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  CodeDto,
  DeletionRequestDto,
  PasswordDto,
  UpdateProfileDto,
} from './dto/security.dto';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { TokensService } from './tokens.service';
import { TwoFactorService } from './two-factor.service';

/** The signed-in person's own account (msfts §8). */
@ApiTags('account')
@ApiBearerAuth('JWT-auth')
@Controller('users/me')
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  @Patch()
  @ApiOperation({ summary: 'Edit my name, phone number or photo' })
  update(@CurrentUser() u: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.account.updateProfile(u.id, dto);
  }

  @Post('phone/send-code')
  @RateLimit({
    name: 'me-phone-code',
    limit: 5,
    windowSeconds: 900,
    by: 'user',
  })
  @HttpCode(HttpStatus.OK)
  sendPhoneCode(@CurrentUser() u: AuthenticatedUser) {
    return this.account.sendPhoneCode(u.id);
  }

  @Post('phone/verify')
  @RateLimit({
    name: 'me-phone-verify',
    limit: 10,
    windowSeconds: 900,
    by: 'user',
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  verifyPhone(@CurrentUser() u: AuthenticatedUser, @Body() dto: CodeDto) {
    return this.account.verifyPhone(u.id, dto.code);
  }

  @Post('password')
  @RateLimit({
    name: 'me-password',
    limit: 10,
    windowSeconds: 900,
    by: 'user',
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change my password (other devices are signed out)',
  })
  async changePassword(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ) {
    const s = await this.auth.changePassword(
      u.id,
      dto.currentPassword,
      dto.newPassword,
      clientCtx(req),
    );
    setRefreshCookie(
      res,
      s.refreshToken,
      (s.refreshExpiresAt.getTime() - Date.now()) / 1000,
    );
    const { refreshToken, refreshExpiresAt, ...rest } = s;
    return wantsTokenInBody(req)
      ? { ...rest, refreshToken, refreshExpiresAt }
      : rest;
  }

  @Get('security')
  @ApiOperation({
    summary: 'Two-step status, phone verification, password age',
  })
  security(@CurrentUser() u: AuthenticatedUser) {
    return this.twoFactor.status(u.id);
  }

  @Post('2fa/totp/setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'New authenticator secret (shown once) and otpauth:// link',
  })
  totpSetup(@CurrentUser() u: AuthenticatedUser) {
    return this.twoFactor.setupTotp(u.id);
  }

  @Post('2fa/totp/enable')
  @RateLimit({
    name: 'me-2fa',
    limit: 10,
    windowSeconds: 900,
    by: 'user',
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  totpEnable(@CurrentUser() u: AuthenticatedUser, @Body() dto: CodeDto) {
    return this.twoFactor.enableTotp(u.id, dto.code);
  }

  @Post('2fa/sms/start')
  @RateLimit({ name: 'me-2fa-sms', limit: 5, windowSeconds: 900, by: 'user' })
  @HttpCode(HttpStatus.OK)
  smsStart(@CurrentUser() u: AuthenticatedUser) {
    return this.twoFactor.startSms(u.id);
  }

  @Post('2fa/sms/confirm')
  @RateLimit({
    name: 'me-2fa',
    limit: 10,
    windowSeconds: 900,
    by: 'user',
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  smsConfirm(@CurrentUser() u: AuthenticatedUser, @Body() dto: CodeDto) {
    return this.twoFactor.confirmSms(u.id, dto.code);
  }

  @Post('2fa/disable')
  @RateLimit({
    name: 'me-2fa-off',
    limit: 10,
    windowSeconds: 900,
    by: 'user',
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  disable(@CurrentUser() u: AuthenticatedUser, @Body() dto: PasswordDto) {
    return this.twoFactor.disable(u.id, dto.password);
  }

  @Post('2fa/recovery-codes')
  @RateLimit({
    name: 'me-2fa-off',
    limit: 10,
    windowSeconds: 900,
    by: 'user',
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  recoveryCodes(@CurrentUser() u: AuthenticatedUser, @Body() dto: PasswordDto) {
    return this.twoFactor.regenerateRecoveryCodes(u.id, dto.password);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Devices signed in to my account' })
  sessions(@CurrentUser() u: AuthenticatedUser) {
    return this.tokens.sessions(u.id, u.sessionId);
  }

  @Delete('sessions/:sessionId')
  @ApiOperation({ summary: 'Sign one device out' })
  revokeSession(
    @CurrentUser() u: AuthenticatedUser,
    @Param('sessionId') id: string,
  ) {
    return this.tokens.revokeSession(u.id, id);
  }

  @Get('data-export')
  @RateLimit({ name: 'me-export', limit: 5, windowSeconds: 3600, by: 'user' })
  @ApiOperation({ summary: 'Download everything we hold about me (JSON)' })
  async dataExport(@CurrentUser() u: AuthenticatedUser) {
    const data = await this.account.dataExport(u.id);
    const buf = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    return new StreamableFile(buf, {
      type: 'application/json; charset=utf-8',
      disposition: `attachment; filename="ekimina-my-data-${new Date().toISOString().slice(0, 10)}.json"`,
      length: buf.length,
    });
  }

  @Get('deletion-request')
  async deletion(@CurrentUser() u: AuthenticatedUser) {
    return {
      request: await this.account.deletionRequest(u.id),
      blockers: await this.account.deletionBlockers(u.id),
    };
  }

  @Post('deletion-request')
  @ApiOperation({
    summary: 'Ask for my account to be deleted (reviewed within 30 days)',
  })
  requestDeletion(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: DeletionRequestDto,
  ) {
    return this.account.requestDeletion(u.id, dto.reason);
  }

  @Delete('deletion-request')
  cancelDeletion(@CurrentUser() u: AuthenticatedUser) {
    return this.account.cancelDeletion(u.id);
  }
}
