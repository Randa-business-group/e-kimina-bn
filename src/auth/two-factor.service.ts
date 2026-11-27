import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  GroupMembershipStatus,
  RoleName,
  TwoFactorMethod,
} from '@prisma/client';
import { compare } from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import type { ClientCtx } from '../common/http-ctx';
import { openSecret, sealSecret } from '../common/secret-box';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './interfaces/jwt-payload.interface';
import { PhoneOtpService } from './phone-otp.service';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const normCode = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function recoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const s = randomBytes(5).toString('hex');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Two-step verification: authenticator app (TOTP) or SMS, plus recovery codes (msfts §8). */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly otp: PhoneOtpService,
    private readonly settings: PlatformSettingsService,
    private readonly audit: AuditService,
  ) {}

  /** True when the platform requires it and the user leads a group. */
  async requiredFor(userId: string): Promise<boolean> {
    if (!(await this.settings.get()).requireLeaderTwoFactor) return false;
    const n = await this.prisma.userGroup.count({
      where: {
        userId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
        role: { name: { in: [RoleName.GROUP_ADMIN, RoleName.TREASURER] } },
      },
    });
    return n > 0;
  }

  async status(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        twoFactorMethod: true,
        twoFactorEnabledAt: true,
        twoFactorRecoveryCodes: true,
        phoneNumber: true,
        phoneVerifiedAt: true,
        passwordChangedAt: true,
        email: true,
      },
    });
    return {
      twoFactor: {
        method: u.twoFactorMethod,
        enabledAt: u.twoFactorEnabledAt,
        recoveryCodesLeft: u.twoFactorRecoveryCodes.length,
        required: await this.requiredFor(userId),
      },
      phone: { number: u.phoneNumber, verified: Boolean(u.phoneVerifiedAt) },
      passwordChangedAt: u.passwordChangedAt,
    };
  }

  private async password(userId: string, password: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!(await compare(password, u.passwordHash))) {
      throw new BadRequestException('Your current password is not right.');
    }
  }

  async setupTotp(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });
    const secret = newTotpSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpPendingSecretEnc: sealSecret(secret) },
    });
    return { secret, otpauthUrl: otpauthUrl(secret, u.email) };
  }

  private async enable(
    userId: string,
    method: TwoFactorMethod,
    extra: object = {},
  ) {
    const codes = recoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorMethod: method,
        twoFactorEnabledAt: new Date(),
        twoFactorRecoveryCodes: codes.map((c) => sha256(normCode(c))),
        ...extra,
      },
    });
    return { method, recoveryCodes: codes };
  }

  async enableTotp(userId: string, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpPendingSecretEnc: true },
    });
    const secret = openSecret(u.totpPendingSecretEnc);
    if (!secret)
      throw new BadRequestException('Start the authenticator setup first.');
    const step = verifyTotp(secret, code);
    if (step == null)
      throw new BadRequestException(
        'That code is not right. Check the time on your phone.',
      );
    return this.enable(userId, TwoFactorMethod.TOTP, {
      totpSecretEnc: sealSecret(secret),
      totpPendingSecretEnc: null,
      totpLastStep: step,
    });
  }

  async startSms(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, phoneNumber: true, phoneVerifiedAt: true },
    });
    if (!u.phoneVerifiedAt)
      throw new BadRequestException(
        'Verify your phone number first (Profile).',
      );
    if (!(await this.otp.send(u, '2FA_SETUP'))) {
      throw new BadRequestException(
        'Could not send an SMS to your phone right now.',
      );
    }
    return { sent: true };
  }

  async confirmSms(userId: string, code: string) {
    await this.otp.verify(userId, '2FA_SETUP', code);
    return this.enable(userId, TwoFactorMethod.SMS, {
      totpSecretEnc: null,
      totpPendingSecretEnc: null,
    });
  }

  async disable(userId: string, password: string) {
    await this.password(userId, password);
    if (await this.requiredFor(userId)) {
      throw new ForbiddenException(
        'Two-step verification is required for group admins and treasurers.',
      );
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorMethod: null,
        twoFactorEnabledAt: null,
        totpSecretEnc: null,
        totpPendingSecretEnc: null,
        totpLastStep: null,
        twoFactorRecoveryCodes: [],
      },
    });
    return { disabled: true };
  }

  async regenerateRecoveryCodes(userId: string, password: string) {
    await this.password(userId, password);
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { twoFactorMethod: true },
    });
    if (!u.twoFactorMethod)
      throw new BadRequestException('Two-step verification is off.');
    const codes = recoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorRecoveryCodes: codes.map((c) => sha256(normCode(c))) },
    });
    return { recoveryCodes: codes };
  }

  // ── sign-in challenge ─────────────────────────────────────────────────

  /** After the first factor: a 5-minute challenge token (and an SMS code for SMS users). */
  async challenge(user: {
    id: string;
    email: string;
    phoneNumber: string | null;
    twoFactorMethod: TwoFactorMethod;
  }) {
    if (user.twoFactorMethod === TwoFactorMethod.SMS) {
      await this.otp.send(user, '2FA_LOGIN');
    }
    const token = await this.jwt.signAsync(
      {
        sub: user.id,
        email: user.email,
        purpose: '2fa',
        m: user.twoFactorMethod,
      } satisfies JwtPayload & { m: string },
      { expiresIn: 300 },
    );
    const digits = (user.phoneNumber ?? '').replace(/\D/g, '');
    return {
      twoFactorRequired: true as const,
      method: user.twoFactorMethod,
      challengeToken: token,
      phoneHint:
        user.twoFactorMethod === TwoFactorMethod.SMS && digits
          ? `••• ${digits.slice(-3)}`
          : null,
    };
  }

  async resendChallenge(challengeToken: string) {
    const p = await this.decode(challengeToken);
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: p.sub },
    });
    if (u.twoFactorMethod !== TwoFactorMethod.SMS)
      throw new BadRequestException('This account uses an authenticator app.');
    await this.otp.send(u, '2FA_LOGIN');
    return { sent: true };
  }

  private async decode(challengeToken: string) {
    try {
      const p = await this.jwt.verifyAsync<JwtPayload>(challengeToken);
      if (p.purpose !== '2fa') throw new Error('purpose');
      return p;
    } catch {
      throw new UnauthorizedException('This sign-in has expired. Start again.');
    }
  }

  private async failed(userId: string, ctx: ClientCtx): Promise<never> {
    const max =
      Number(process.env.LOGIN_MAX_ATTEMPTS) > 0
        ? Number(process.env.LOGIN_MAX_ATTEMPTS)
        : 5;
    const lockMin =
      Number(process.env.LOGIN_LOCK_MINUTES) > 0
        ? Number(process.env.LOGIN_LOCK_MINUTES)
        : 15;
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { failedLoginAttempts: true },
    });
    const attempts = u.failedLoginAttempts + 1;
    const lock = attempts >= max;
    await this.prisma.user.update({
      where: { id: userId },
      data: lock
        ? {
            failedLoginAttempts: 0,
            lockedUntil: new Date(Date.now() + lockMin * 60_000),
          }
        : { failedLoginAttempts: attempts },
    });
    void this.audit.record({
      action: lock ? 'auth.account_locked' : 'auth.two_factor_failed',
      actorId: userId,
      entityType: 'User',
      entityId: userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      statusCode: 401,
    });
    throw new UnauthorizedException(
      lock
        ? `Too many wrong codes. Your account is locked for ${lockMin} minutes.`
        : 'That code is not right.',
    );
  }

  /** Second factor: authenticator / SMS code or a recovery code. Returns the user id. */
  async verifyChallenge(
    challengeToken: string,
    input: { code?: string; recoveryCode?: string },
    ctx: ClientCtx,
  ) {
    const p = await this.decode(challengeToken);
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: p.sub },
    });
    if (u.lockedUntil && u.lockedUntil > new Date()) {
      throw new UnauthorizedException(
        'Too many failed attempts. Try again later or contact support.',
      );
    }
    if (!u.twoFactorMethod) return u.id;
    if (input.recoveryCode) {
      const h = sha256(normCode(input.recoveryCode));
      if (!u.twoFactorRecoveryCodes.includes(h)) return this.failed(u.id, ctx);
      await this.prisma.user.update({
        where: { id: u.id },
        data: {
          twoFactorRecoveryCodes: u.twoFactorRecoveryCodes.filter(
            (c) => c !== h,
          ),
          failedLoginAttempts: 0,
        },
      });
      void this.audit.record({
        action: 'auth.recovery_code_used',
        actorId: u.id,
        entityType: 'User',
        entityId: u.id,
        ip: ctx.ip,
      });
      return u.id;
    }
    const code = (input.code ?? '').trim();
    if (u.twoFactorMethod === TwoFactorMethod.TOTP) {
      const secret = openSecret(u.totpSecretEnc);
      const step = secret ? verifyTotp(secret, code) : null;
      if (step == null || (u.totpLastStep != null && step <= u.totpLastStep))
        return this.failed(u.id, ctx);
      await this.prisma.user.update({
        where: { id: u.id },
        data: { totpLastStep: step, failedLoginAttempts: 0 },
      });
      return u.id;
    }
    try {
      await this.otp.verify(u.id, '2FA_LOGIN', code);
    } catch {
      return this.failed(u.id, ctx);
    }
    await this.prisma.user.update({
      where: { id: u.id },
      data: { failedLoginAttempts: 0 },
    });
    return u.id;
  }
}
