import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcryptjs';
import { appConfig } from '../config/app.config';
import { EmailService } from '../email/email.service.js';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { AuthResponseDto } from './dto/auth-response.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RegisterPendingDto } from './dto/register-result.dto';
import { CompletePasswordResetDto } from './dto/complete-password-reset.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { VerifyResetOtpDto } from './dto/verify-reset-otp.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { Prisma, RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { SmsService, normalizePhone } from '../notifications/sms.service';
import type { ClientCtx } from '../common/http-ctx';
import { MAX_OTP_ATTEMPTS, PhoneOtpService } from './phone-otp.service';
import { TokensService } from './tokens.service';
import { TwoFactorService } from './two-factor.service';

export type AuthSession = AuthResponseDto & {
  refreshToken: string;
  refreshExpiresAt: Date;
};

export type LoginResult =
  | AuthSession
  | Awaited<ReturnType<TwoFactorService['challenge']>>;

const NO_CTX: ClientCtx = { ip: null, userAgent: null };

type AppConfig = ReturnType<typeof appConfig>;

export type RegisterResult = AuthSession | RegisterPendingDto;

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly audit: AuditService,
    private readonly platform: PlatformSettingsService,
    private readonly sms: SmsService,
    private readonly tokens: TokensService,
    private readonly phoneOtp: PhoneOtpService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  /** Store a phone in canonical form and claim its phoneKey (unique) when free. */
  private async applyPhone(userId: string, phone: string | null | undefined) {
    const key = normalizePhone(phone);
    if (!key) return;
    const taken = await this.prisma.user.findFirst({
      where: { phoneKey: key, id: { not: userId } },
      select: { id: true },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { phoneNumber: `+${key}`, ...(taken ? {} : { phoneKey: key }) },
    });
  }

  /** Wrong one-time code: count it and void the code after MAX_OTP_ATTEMPTS. */
  private async wrongOtp(
    userId: string,
    attempts: number,
    clear: Prisma.UserUpdateInput,
  ): Promise<never> {
    const n = attempts + 1;
    await this.prisma.user.update({
      where: { id: userId },
      data:
        n >= MAX_OTP_ATTEMPTS
          ? { otpFailedAttempts: 0, ...clear }
          : { otpFailedAttempts: n },
    });
    throw new UnauthorizedException(
      n >= MAX_OTP_ATTEMPTS
        ? 'Too many wrong codes. Request a new one.'
        : 'Invalid verification code.',
    );
  }

  private get smtpOn(): boolean {
    return Boolean(process.env.SMTP_HOST?.trim());
  }

  /** One-time code by SMS (msfts §7). The log keeps the code masked. */
  private async smsCode(
    phone: string | null | undefined,
    userId: string,
    otp: string,
    kind: 'OTP_VERIFY' | 'OTP_RESET',
  ): Promise<boolean> {
    if (!phone || !this.sms.enabled || !normalizePhone(phone)) return false;
    const minutes = Math.round(
      (this.getOtpExpiryDate().getTime() - Date.now()) / 60000,
    );
    const what = kind === 'OTP_VERIFY' ? 'verification' : 'password reset';
    const text = (code: string) =>
      `Your E-kimina ${what} code is ${code}. It expires in ${minutes} minutes. Never share it.`;
    const r = await this.sms.send({
      to: phone,
      message: text(otp),
      logMessage: text('******'),
      kind,
      userId,
    });
    return r.status === 'SENT';
  }

  private get maxLoginAttempts(): number {
    const n = Number(process.env.LOGIN_MAX_ATTEMPTS);
    return Number.isInteger(n) && n > 0 ? n : 5;
  }

  private get lockMinutes(): number {
    const n = Number(process.env.LOGIN_LOCK_MINUTES);
    return Number.isFinite(n) && n > 0 ? n : 15;
  }

  private getOtpExpiryDate(): Date {
    const minutes = Number.parseInt(
      process.env.OTP_EXPIRATION_MINUTES ?? '15',
      10,
    );
    const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
    return new Date(Date.now() + safe * 60 * 1000);
  }

  private generateOtp(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  async register(
    registerDto: RegisterDto,
    ctx: ClientCtx = NO_CTX,
  ): Promise<RegisterResult> {
    const invitationToken = registerDto.invitationToken?.trim();
    if (invitationToken) {
      const treasurerInv = await this.prisma.treasurerInvitation.findUnique({
        where: { token: invitationToken },
      });
      if (treasurerInv) {
        return this.registerWithTreasurerInvitation(
          registerDto,
          invitationToken,
          ctx,
        );
      }
      const memberInv = await this.prisma.memberInvitation.findUnique({
        where: { token: invitationToken },
      });
      if (memberInv) {
        return this.registerWithMemberInvitation(
          registerDto,
          invitationToken,
          ctx,
        );
      }
      throw new BadRequestException('Invalid invitation token.');
    }

    if (!(await this.platform.get()).signupsEnabled) {
      throw new BadRequestException(
        'New sign-ups are closed for now. Ask a group admin to invite you.',
      );
    }

    const email = registerDto.email.trim().toLowerCase();
    const existingUser = await this.usersService.findByEmail(email);

    if (existingUser) {
      if (!existingUser.isActive) {
        throw new BadRequestException(
          'Complete registration using the invitation link sent to your email.',
        );
      }
      throw new ConflictException('A user with this email already exists.');
    }

    const canSms =
      this.sms.enabled && Boolean(normalizePhone(registerDto.phoneNumber));
    if (!this.smtpOn && !canSms) {
      throw new BadRequestException(
        'Verification needs email (SMTP) or SMS. Add a phone number or ask the platform to set up email.',
      );
    }

    const passwordHash = await hash(
      registerDto.password,
      this.configService.get('auth.bcryptSaltRounds', { infer: true }),
    );

    const otp = this.generateOtp();
    const otpHash = await hash(
      otp,
      this.configService.get('auth.bcryptSaltRounds', { infer: true }),
    );
    const expiresAt = this.getOtpExpiryDate();

    const user = await this.usersService.create({
      email,
      fullName: registerDto.fullName,
      passwordHash,
      phoneNumber: registerDto.phoneNumber,
      image: registerDto.image,
      emailVerified: false,
      emailVerificationOtpHash: otpHash,
      emailVerificationExpiresAt: expiresAt,
    });
    await this.applyPhone(user.id, registerDto.phoneNumber);

    let emailed = false;
    if (this.smtpOn) {
      try {
        await this.emailService.sendVerificationEmail(
          email,
          otp,
          registerDto.fullName.split(/\s+/)[0] || registerDto.fullName,
        );
        emailed = true;
      } catch {
        emailed = false;
      }
    }
    const texted = await this.smsCode(
      registerDto.phoneNumber,
      user.id,
      otp,
      'OTP_VERIFY',
    );
    if (!emailed && !texted) {
      await this.prisma.user.delete({ where: { id: user.id } }).catch(() => {});
      throw new BadRequestException(
        'Could not send the verification code. Please try again.',
      );
    }

    const pending: RegisterPendingDto = {
      needsEmailVerification: true,
      email,
      message:
        emailed && texted
          ? 'We sent a verification code to your email and phone.'
          : texted
            ? 'We sent a verification code to your phone by SMS.'
            : 'We sent a verification code to your email.',
    };
    return pending;
  }

  async previewTreasurerInvitation(token: string): Promise<{ email: string }> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new BadRequestException('Token is required.');
    }

    const invitation = await this.prisma.treasurerInvitation.findUnique({
      where: { token: trimmed },
      include: { user: { select: { email: true } } },
    });

    if (invitation && invitation.expiresAt >= new Date()) {
      return { email: invitation.user.email };
    }

    const memberInv = await this.prisma.memberInvitation.findUnique({
      where: { token: trimmed },
      include: { user: { select: { email: true } } },
    });

    if (memberInv && memberInv.expiresAt >= new Date()) {
      return { email: memberInv.user.email };
    }

    throw new NotFoundException('Invitation not found or expired.');
  }

  private async registerWithTreasurerInvitation(
    registerDto: RegisterDto,
    invitationToken: string,
    ctx: ClientCtx,
  ): Promise<AuthSession> {
    const invitation = await this.prisma.treasurerInvitation.findUnique({
      where: { token: invitationToken },
      include: { user: true },
    });

    if (!invitation || invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation is invalid or has expired.');
    }

    const normalizedEmail = registerDto.email.trim().toLowerCase();
    if (invitation.user.email.toLowerCase() !== normalizedEmail) {
      throw new BadRequestException('Email does not match this invitation.');
    }

    if (invitation.user.isActive) {
      throw new BadRequestException('This account is already active.');
    }

    const passwordHash = await hash(
      registerDto.password,
      this.configService.get('auth.bcryptSaltRounds', { infer: true }),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: invitation.userId },
        data: {
          fullName: registerDto.fullName,
          passwordHash,
          phoneNumber: registerDto.phoneNumber,
          image: registerDto.image,
          isActive: true,
          emailVerified: true,
          emailVerificationOtpHash: null,
          emailVerificationExpiresAt: null,
        },
      });
      await tx.treasurerInvitation.delete({ where: { id: invitation.id } });
    });
    await this.applyPhone(invitation.userId, registerDto.phoneNumber);

    const user = await this.usersService.findById(invitation.userId);
    return this.buildAuthResponse(user, ctx);
  }

  private async registerWithMemberInvitation(
    registerDto: RegisterDto,
    invitationToken: string,
    ctx: ClientCtx,
  ): Promise<AuthSession> {
    const invitation = await this.prisma.memberInvitation.findUnique({
      where: { token: invitationToken },
      include: { user: true },
    });

    if (!invitation || invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation is invalid or has expired.');
    }

    const normalizedEmail = registerDto.email.trim().toLowerCase();
    if (invitation.user.email.toLowerCase() !== normalizedEmail) {
      throw new BadRequestException('Email does not match this invitation.');
    }

    if (invitation.user.isActive) {
      throw new BadRequestException('This account is already active.');
    }

    const passwordHash = await hash(
      registerDto.password,
      this.configService.get('auth.bcryptSaltRounds', { infer: true }),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: invitation.userId },
        data: {
          fullName: registerDto.fullName,
          passwordHash,
          phoneNumber: registerDto.phoneNumber,
          image: registerDto.image,
          isActive: true,
          emailVerified: true,
          emailVerificationOtpHash: null,
          emailVerificationExpiresAt: null,
        },
      });
      await tx.memberInvitation.delete({ where: { id: invitation.id } });
    });
    await this.applyPhone(invitation.userId, registerDto.phoneNumber);

    const user = await this.usersService.findById(invitation.userId);
    return this.buildAuthResponse(user, ctx);
  }

  async verifyEmail(
    dto: VerifyEmailDto,
    ctx: ClientCtx = NO_CTX,
  ): Promise<AuthSession> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      throw new UnauthorizedException('Invalid email or verification code.');
    }

    if (user.emailVerified) {
      throw new BadRequestException('This email is already verified.');
    }

    if (!user.emailVerificationOtpHash || !user.emailVerificationExpiresAt) {
      throw new BadRequestException(
        'No verification code pending. Request a new code.',
      );
    }

    if (user.emailVerificationExpiresAt < new Date()) {
      throw new BadRequestException(
        'Verification code expired. Request a new code.',
      );
    }

    const matches = await compare(dto.otp, user.emailVerificationOtpHash);
    if (!matches) {
      return this.wrongOtp(user.id, user.otpFailedAttempts, {
        emailVerificationOtpHash: null,
        emailVerificationExpiresAt: null,
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        otpFailedAttempts: 0,
        emailVerified: true,
        emailVerificationOtpHash: null,
        emailVerificationExpiresAt: null,
      },
    });

    const profile = await this.usersService.findById(user.id);
    return this.buildAuthResponse(profile, ctx);
  }

  async resendVerification(
    dto: ResendVerificationDto,
  ): Promise<{ message: string }> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(email);

    const generic: { message: string } = {
      message:
        'If an account exists and needs verification, we sent a new code.',
    };

    if (!user || user.emailVerified || !user.isActive) {
      return generic;
    }

    const canSmsResend =
      this.sms.enabled && Boolean(normalizePhone(user.phoneNumber));
    if (!this.smtpOn && !canSmsResend) {
      return generic;
    }

    const otp = this.generateOtp();
    const otpHash = await hash(
      otp,
      this.configService.get('auth.bcryptSaltRounds', { infer: true }),
    );
    const expiresAt = this.getOtpExpiryDate();

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationOtpHash: otpHash,
        emailVerificationExpiresAt: expiresAt,
        otpFailedAttempts: 0,
      },
    });

    if (this.smtpOn) {
      try {
        await this.emailService.sendVerificationEmail(
          email,
          otp,
          user.fullName.split(/\s+/)[0] || user.fullName,
        );
      } catch {
        // Do not reveal SMTP failure
      }
    }
    await this.smsCode(user.phoneNumber, user.id, otp, 'OTP_VERIFY');

    return generic;
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(email);

    const generic: { message: string } = {
      message:
        'If an account exists for this email, we sent password reset instructions.',
    };

    if (!user || !user.isActive || !user.emailVerified || user.suspendedAt) {
      return generic;
    }

    const canSmsReset =
      this.sms.enabled && Boolean(normalizePhone(user.phoneNumber));
    if (!this.smtpOn && !canSmsReset) {
      return generic;
    }

    const otp = this.generateOtp();
    const otpHash = await hash(
      otp,
      this.configService.get('auth.bcryptSaltRounds', { infer: true }),
    );
    const expiresAt = this.getOtpExpiryDate();

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetOtpHash: otpHash,
        passwordResetExpiresAt: expiresAt,
        otpFailedAttempts: 0,
      },
    });

    let emailed = false;
    if (this.smtpOn) {
      try {
        await this.emailService.sendPasswordResetEmail(
          email,
          otp,
          user.fullName.split(/\s+/)[0] || user.fullName,
        );
        emailed = true;
      } catch {
        emailed = false;
      }
    }
    const texted = await this.smsCode(
      user.phoneNumber,
      user.id,
      otp,
      'OTP_RESET',
    );
    if (!emailed && !texted) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetOtpHash: null,
          passwordResetExpiresAt: null,
        },
      });
    }

    return generic;
  }

  /** Step 1: validate email + OTP; returns a short-lived token for step 2 only. */
  async verifyResetOtp(
    dto: VerifyResetOtpDto,
  ): Promise<{ resetToken: string }> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.usersService.findByEmail(email);

    if (!user) {
      throw new UnauthorizedException('Invalid email or verification code.');
    }

    if (!user.passwordResetOtpHash || !user.passwordResetExpiresAt) {
      throw new BadRequestException(
        'No password reset in progress. Request a new code.',
      );
    }

    if (user.passwordResetExpiresAt < new Date()) {
      throw new BadRequestException(
        'Reset code expired. Request a new password reset.',
      );
    }

    const matches = await compare(dto.otp, user.passwordResetOtpHash);
    if (!matches) {
      return this.wrongOtp(user.id, user.otpFailedAttempts, {
        passwordResetOtpHash: null,
        passwordResetExpiresAt: null,
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        otpFailedAttempts: 0,
        passwordResetOtpHash: null,
        passwordResetExpiresAt: null,
      },
    });

    const resetToken = await this.jwtService.signAsync(
      {
        sub: user.id,
        email: user.email,
        purpose: 'password_reset' as const,
      },
      { expiresIn: '15m' },
    );

    return { resetToken };
  }

  /** Step 2: set new password; does not log the user in. */
  async completePasswordReset(
    dto: CompletePasswordResetDto,
  ): Promise<{ message: string }> {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(dto.resetToken);
    } catch {
      throw new BadRequestException(
        'Invalid or expired reset session. Start the reset flow again.',
      );
    }

    if (payload.purpose !== 'password_reset') {
      throw new BadRequestException('Invalid reset session.');
    }

    const passwordHash = await hash(
      dto.password,
      this.configService.get('auth.bcryptSaltRounds', { infer: true }),
    );

    // A new password ends every session (access and refresh) and clears a lockout.
    await this.prisma.user.update({
      where: { id: payload.sub },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    await this.tokens.revokeAll(payload.sub, 'password-reset');

    return {
      message: 'Password updated. Sign in with your new password.',
    };
  }

  async login(
    loginDto: LoginDto,
    ctx: ClientCtx = NO_CTX,
  ): Promise<LoginResult> {
    const requestMeta = { ip: ctx.ip, userAgent: ctx.userAgent };
    const email = loginDto.email?.trim().toLowerCase();
    const phone = loginDto.phone?.trim();
    if (!email && !phone) {
      throw new BadRequestException('Enter your email or phone number.');
    }
    const user = email
      ? await this.usersService.findByEmail(email)
      : await this.phoneOtp.findByPhone(phone!);
    const who = email ?? phone;

    if (!user) {
      void this.audit.record({
        action: 'auth.login_failed',
        entityType: 'User',
        meta: { identifier: who, reason: 'unknown account' },
        ...requestMeta,
      });
      throw new UnauthorizedException('Invalid Credentials.');
    }

    this.assertNotLocked(user);

    const passwordMatches = await compare(loginDto.password, user.passwordHash);

    if (!passwordMatches) {
      const attempts = (user.lockedUntil ? 0 : user.failedLoginAttempts) + 1;
      const lock = attempts >= this.maxLoginAttempts;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: lock ? 0 : attempts,
          lockedUntil: lock
            ? new Date(Date.now() + this.lockMinutes * 60_000)
            : null,
        },
      });
      void this.audit.record({
        action: lock ? 'auth.account_locked' : 'auth.login_failed',
        actorId: user.id,
        entityType: 'User',
        entityId: user.id,
        meta: { identifier: who, attempts },
        ...requestMeta,
      });
      if (lock) {
        throw new UnauthorizedException(
          `Too many failed sign-in attempts. Your account is locked for ${this.lockMinutes} minutes.`,
        );
      }
      throw new UnauthorizedException('Invalid Credentials.');
    }

    return this.afterFirstFactor(user, ctx);
  }

  private assertNotLocked(user: { lockedUntil: Date | null }) {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      throw new UnauthorizedException(
        `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'} or contact support.`,
      );
    }
  }

  /** Account checks, then either a two-step challenge or a session. */
  private async afterFirstFactor(
    user: NonNullable<Awaited<ReturnType<UsersService['findByEmail']>>>,
    ctx: ClientCtx,
  ): Promise<LoginResult> {
    if (user.suspendedAt) {
      throw new UnauthorizedException(
        'This account is suspended. Contact support.',
      );
    }

    if (!user.isActive) {
      throw new UnauthorizedException(
        'Complete registration using your invitation link before signing in.',
      );
    }

    if (!user.emailVerified) {
      throw new UnauthorizedException(
        'Verify your email before signing in. Check your inbox for the code or request a new one from the sign-up page.',
      );
    }

    if (user.twoFactorMethod) {
      return this.twoFactor.challenge({
        id: user.id,
        email: user.email,
        phoneNumber: user.phoneNumber,
        twoFactorMethod: user.twoFactorMethod,
      });
    }
    return this.startSession(user.id, ctx);
  }

  private async startSession(
    userId: string,
    ctx: ClientCtx,
  ): Promise<AuthSession> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      },
    });
    const safeUser = await this.usersService.findById(userId);
    return this.buildAuthResponse(safeUser, ctx);
  }

  /** Second step of a two-step sign-in. */
  async completeTwoFactor(
    input: { challengeToken: string; code?: string; recoveryCode?: string },
    ctx: ClientCtx,
  ): Promise<AuthSession> {
    const userId = await this.twoFactor.verifyChallenge(
      input.challengeToken,
      { code: input.code, recoveryCode: input.recoveryCode },
      ctx,
    );
    return this.startSession(userId, ctx);
  }

  resendTwoFactorCode(challengeToken: string) {
    return this.twoFactor.resendChallenge(challengeToken);
  }

  /** Phone sign-in step 1: text a code (always the same answer). */
  async requestPhoneLogin(phone: string): Promise<{ message: string }> {
    const generic = {
      message:
        'If an account uses this number, we sent it a sign-in code by SMS.',
    };
    const user = await this.phoneOtp.findByPhone(phone);
    if (
      !user ||
      !user.isActive ||
      user.suspendedAt ||
      user.twoFactorMethod === 'SMS' ||
      (user.lockedUntil && user.lockedUntil > new Date())
    ) {
      return generic;
    }
    await this.phoneOtp.send(user, 'LOGIN');
    return generic;
  }

  /** Phone sign-in step 2: the code proves the phone; TOTP users still get a challenge. */
  async verifyPhoneLogin(
    phone: string,
    code: string,
    ctx: ClientCtx,
  ): Promise<LoginResult> {
    const user = await this.phoneOtp.findByPhone(phone);
    if (!user) throw new UnauthorizedException('Invalid phone number or code.');
    this.assertNotLocked(user);
    try {
      await this.phoneOtp.verify(user.id, 'LOGIN', code);
    } catch (e) {
      void this.audit.record({
        action: 'auth.login_failed',
        actorId: user.id,
        entityType: 'User',
        entityId: user.id,
        meta: { identifier: phone, reason: 'phone code' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw e;
    }
    const patch: Prisma.UserUpdateInput = {};
    if (!user.phoneVerifiedAt) patch.phoneVerifiedAt = new Date();
    // The code reached the account's own phone, so the account is real.
    if (!user.emailVerified) patch.emailVerified = true;
    if (Object.keys(patch).length) {
      await this.prisma.user.update({ where: { id: user.id }, data: patch });
      user.emailVerified = true;
    }
    return this.afterFirstFactor(user, ctx);
  }

  /** Rotate the refresh token (cookie or body) into a fresh session. */
  async refresh(raw: string | null, ctx: ClientCtx): Promise<AuthSession> {
    if (!raw) throw new UnauthorizedException('Please sign in again.');
    const r = await this.tokens.rotate(raw, ctx, async (id) => {
      const p = await this.usersService.findById(id);
      return p.platformRole;
    });
    const user = await this.usersService.findById(r.userId);
    return {
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      refreshExpiresAt: r.refreshExpiresAt,
      user,
    };
  }

  async logout(raw: string | null, sessionId?: string) {
    await this.tokens.revokeRaw(raw);
    if (sessionId) {
      const row = await this.prisma.refreshToken.findUnique({
        where: { id: sessionId },
        select: { familyId: true },
      });
      if (row) await this.tokens.revokeFamily(row.familyId, 'logout');
    }
    return { signedOut: true };
  }

  async logoutAll(userId: string) {
    await this.tokens.revokeAll(userId, 'logout-all');
    return { signedOut: true };
  }

  /** Change password while signed in: every other device is signed out. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ctx: ClientCtx,
  ): Promise<AuthSession> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!(await compare(currentPassword, u.passwordHash))) {
      throw new BadRequestException('Your current password is not right.');
    }
    if (await compare(newPassword, u.passwordHash)) {
      throw new BadRequestException(
        'Choose a new password, not the current one.',
      );
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await hash(
          newPassword,
          this.configService.get('auth.bcryptSaltRounds', { infer: true }),
        ),
        passwordChangedAt: new Date(),
      },
    });
    await this.tokens.revokeAll(userId, 'password-changed');
    return this.buildAuthResponse(
      await this.usersService.findById(userId),
      ctx,
    );
  }

  /** Access token only (impersonation sessions have no refresh token). */
  issueToken(
    user: { id: string; email: string; platformRole: RoleName },
    extra: Pick<JwtPayload, 'imp' | 'ro'> = {},
    expiresIn?: number,
  ): Promise<string> {
    return this.tokens.accessToken(user, extra, expiresIn);
  }

  private async buildAuthResponse(
    user: Awaited<ReturnType<UsersService['findById']>>,
    ctx: ClientCtx = NO_CTX,
  ): Promise<AuthSession> {
    const s = await this.tokens.issue(user, ctx);
    return {
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      refreshExpiresAt: s.refreshExpiresAt,
      user,
    };
  }
}
