import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  clearRefreshCookie,
  clientCtx,
  originAllowed,
  readCookie,
  REFRESH_COOKIE,
  setRefreshCookie,
  wantsTokenInBody,
  type HttpReq,
  type HttpRes,
} from '../common/http-ctx';
import { RateLimit } from '../common/rate-limit';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UsersService } from '../users/users.service';
import { AuthService, type AuthSession } from './auth.service';
import { CompletePasswordResetDto } from './dto/complete-password-reset.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import {
  ChallengeDto,
  PhoneDto,
  PhoneVerifyDto,
  RefreshDto,
  TwoFactorVerifyDto,
} from './dto/security.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { VerifyResetOtpDto } from './dto/verify-reset-otp.dto';
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface';

/**
 * Sessions: a short-lived access token in the body (kept in memory by the web app) and a
 * rotating refresh token in an httpOnly cookie (msfts §8). Clients that cannot use cookies
 * send `X-Token-Transport: body` and get the refresh token in the body instead.
 */
function deliver(result: unknown, req: HttpReq, res: HttpRes) {
  if (!result || typeof result !== 'object' || !('refreshToken' in result)) {
    return result;
  }
  const { refreshToken, refreshExpiresAt, ...rest } = result as AuthSession;
  setRefreshCookie(
    res,
    refreshToken,
    (refreshExpiresAt.getTime() - Date.now()) / 1000,
  );
  return wantsTokenInBody(req)
    ? { ...rest, refreshToken, refreshExpiresAt }
    : rest;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('register')
  @Public()
  @RateLimit({ name: 'register', limit: 10, windowSeconds: 3600, by: 'ip' })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Register (verification code by email / SMS) or complete a group invitation (session)',
  })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ) {
    return deliver(
      await this.authService.register(dto, clientCtx(req)),
      req,
      res,
    );
  }

  @Post('verify-email')
  @Public()
  @RateLimit({
    name: 'verify-email',
    limit: 10,
    windowSeconds: 900,
    by: 'ip+body',
    bodyKey: 'email',
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ) {
    return deliver(
      await this.authService.verifyEmail(dto, clientCtx(req)),
      req,
      res,
    );
  }

  @Post('resend-verification')
  @Public()
  @RateLimit({
    name: 'resend-verification',
    limit: 5,
    windowSeconds: 900,
    by: 'ip+body',
    bodyKey: 'email',
  })
  @HttpCode(HttpStatus.OK)
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto);
  }

  @Post('forgot-password')
  @Public()
  @RateLimit({
    name: 'forgot-password',
    limit: 5,
    windowSeconds: 900,
    by: 'ip+body',
    bodyKey: 'email',
  })
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password/verify-otp')
  @Public()
  @RateLimit({
    name: 'reset-otp',
    limit: 10,
    windowSeconds: 900,
    by: 'ip+body',
    bodyKey: 'email',
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  verifyResetOtp(@Body() dto: VerifyResetOtpDto) {
    return this.authService.verifyResetOtp(dto);
  }

  @Post('reset-password/complete')
  @Public()
  @RateLimit({
    name: 'reset-complete',
    limit: 10,
    windowSeconds: 900,
    by: 'ip',
  })
  @HttpCode(HttpStatus.OK)
  completePasswordReset(@Body() dto: CompletePasswordResetDto) {
    return this.authService.completePasswordReset(dto);
  }

  @Get('treasurer-invitation')
  @Public()
  @ApiOperation({
    summary: 'Resolve an invitation token for the registration form',
  })
  previewTreasurerInvitation(@Query('token') token?: string) {
    return this.authService.previewTreasurerInvitation(token ?? '');
  }

  @Post('login')
  @Public()
  @RateLimit({
    name: 'login',
    limit: 10,
    windowSeconds: 900,
    by: 'ip+body',
    bodyKey: ['email', 'phone'],
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sign in with email or phone + password. Returns a session or a two-step challenge.',
  })
  async login(
    @Body() dto: LoginDto,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ) {
    return deliver(await this.authService.login(dto, clientCtx(req)), req, res);
  }

  @Post('phone/request-code')
  @Public()
  @RateLimit({
    name: 'phone-code',
    limit: 5,
    windowSeconds: 900,
    by: 'ip+body',
    bodyKey: 'phone',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Phone sign-in step 1: text a 6-digit code' })
  requestPhoneCode(@Body() dto: PhoneDto) {
    return this.authService.requestPhoneLogin(dto.phone);
  }

  @Post('phone/verify')
  @Public()
  @RateLimit({
    name: 'phone-verify',
    limit: 10,
    windowSeconds: 900,
    by: 'ip+body',
    bodyKey: 'phone',
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Phone sign-in step 2: code → session (or authenticator challenge)',
  })
  async verifyPhone(
    @Body() dto: PhoneVerifyDto,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ) {
    return deliver(
      await this.authService.verifyPhoneLogin(
        dto.phone,
        dto.code,
        clientCtx(req),
      ),
      req,
      res,
    );
  }

  @Post('2fa/verify')
  @Public()
  @RateLimit({
    name: '2fa-verify',
    limit: 10,
    windowSeconds: 900,
    by: 'ip',
    failuresOnly: true,
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Two-step sign-in: authenticator / SMS code or a recovery code',
  })
  async verifyTwoFactor(
    @Body() dto: TwoFactorVerifyDto,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ) {
    return deliver(
      await this.authService.completeTwoFactor(dto, clientCtx(req)),
      req,
      res,
    );
  }

  @Post('2fa/resend')
  @Public()
  @RateLimit({ name: '2fa-resend', limit: 3, windowSeconds: 900, by: 'ip' })
  @HttpCode(HttpStatus.OK)
  resendTwoFactor(@Body() dto: ChallengeDto) {
    return this.authService.resendTwoFactorCode(dto.challengeToken);
  }

  @Post('refresh')
  @Public()
  @RateLimit({ name: 'refresh', limit: 60, windowSeconds: 60, by: 'ip' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Exchange the refresh cookie for a new access token (rotates the cookie)',
  })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: HttpReq,
    @Res({ passthrough: true }) res: HttpRes,
  ) {
    if (!originAllowed(req))
      throw new ForbiddenException('Origin not allowed.');
    const raw = readCookie(req, REFRESH_COOKIE) ?? dto?.refreshToken ?? null;
    try {
      return deliver(
        await this.authService.refresh(raw, clientCtx(req)),
        req,
        res,
      );
    } catch (e) {
      clearRefreshCookie(res);
      throw e;
    }
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sign this device out (revokes its refresh token, clears the cookie)',
  })
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: HttpReq & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) res: HttpRes,
  ) {
    if (!originAllowed(req))
      throw new ForbiddenException('Origin not allowed.');
    clearRefreshCookie(res);
    return this.authService.logout(
      readCookie(req, REFRESH_COOKIE) ?? dto?.refreshToken ?? null,
    );
  }

  @Post('logout-all')
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out on every device' })
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: HttpRes,
  ) {
    clearRefreshCookie(res);
    return this.authService.logoutAll(user.id);
  }

  @Get('profile')
  @ApiBearerAuth('JWT-auth')
  @ApiOkResponse({ type: UserResponseDto })
  profile(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.findById(user.id);
  }
}
