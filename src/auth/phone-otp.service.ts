import { randomInt } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { SmsService, normalizePhone } from '../notifications/sms.service';
import { PrismaService } from '../prisma/prisma.service';

export type PhoneOtpPurpose = 'LOGIN' | 'VERIFY' | '2FA_SETUP' | '2FA_LOGIN';

export const MAX_OTP_ATTEMPTS = 5;

const TEXT: Record<PhoneOtpPurpose, string> = {
  LOGIN: 'sign-in',
  VERIFY: 'phone verification',
  '2FA_SETUP': 'two-step setup',
  '2FA_LOGIN': 'sign-in (two-step)',
};

/** SMS one-time codes stored hashed on the user (msfts §8). 5 wrong tries void the code. */
@Injectable()
export class PhoneOtpService {
  private lastBackfill = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  get minutes(): number {
    const n = Number(process.env.OTP_EXPIRATION_MINUTES);
    return Number.isFinite(n) && n > 0 ? n : 15;
  }

  /**
   * Users created outside the API (seeds, imports) get their phoneKey here.
   * Runs at most once a minute.
   */
  async backfillPhoneKeys(force = false) {
    if (!force && Date.now() - this.lastBackfill < 60_000) return;
    this.lastBackfill = Date.now();
    const rows = await this.prisma.user.findMany({
      where: { phoneKey: null, phoneNumber: { not: null } },
      select: { id: true, phoneNumber: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });
    for (const r of rows) {
      const key = normalizePhone(r.phoneNumber);
      if (!key) continue;
      await this.prisma.user
        .updateMany({
          where: { id: r.id, phoneKey: null },
          data: { phoneKey: key },
        })
        .catch(() => undefined); // taken by another account
    }
  }

  async findByPhone(phone: string) {
    const key = normalizePhone(phone);
    if (!key) return null;
    let u = await this.prisma.user.findUnique({ where: { phoneKey: key } });
    if (!u) {
      await this.backfillPhoneKeys();
      u = await this.prisma.user.findUnique({ where: { phoneKey: key } });
    }
    return u;
  }

  /** Issues a code and texts it. Returns false when SMS could not be sent. */
  async send(
    user: { id: string; phoneNumber: string | null },
    purpose: PhoneOtpPurpose,
  ): Promise<boolean> {
    if (!this.sms.enabled || !normalizePhone(user.phoneNumber)) return false;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        phoneOtpHash: await hash(code, 8),
        phoneOtpExpiresAt: new Date(Date.now() + this.minutes * 60_000),
        phoneOtpPurpose: purpose,
        otpFailedAttempts: 0,
      },
    });
    const text = (c: string) =>
      `Your E-kimina ${TEXT[purpose]} code is ${c}. It expires in ${this.minutes} minutes. Never share it.`;
    const r = await this.sms.send({
      to: user.phoneNumber!,
      message: text(code),
      logMessage: text('******'),
      kind: `OTP_${purpose}`,
      userId: user.id,
    });
    return r.status === 'SENT';
  }

  /** Throws on a wrong / expired / used-up code; clears the code on success. */
  async verify(userId: string, purpose: PhoneOtpPurpose, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        phoneOtpHash: true,
        phoneOtpExpiresAt: true,
        phoneOtpPurpose: true,
        otpFailedAttempts: true,
      },
    });
    if (
      !u.phoneOtpHash ||
      u.phoneOtpPurpose !== purpose ||
      !u.phoneOtpExpiresAt
    ) {
      throw new BadRequestException('No code is waiting. Request a new one.');
    }
    if (u.phoneOtpExpiresAt < new Date()) {
      throw new BadRequestException(
        'This code has expired. Request a new one.',
      );
    }
    const ok =
      /^\d{6}$/.test(code.trim()) &&
      (await compare(code.trim(), u.phoneOtpHash));
    if (!ok) {
      const attempts = u.otpFailedAttempts + 1;
      await this.prisma.user.update({
        where: { id: userId },
        data:
          attempts >= MAX_OTP_ATTEMPTS
            ? {
                otpFailedAttempts: 0,
                phoneOtpHash: null,
                phoneOtpExpiresAt: null,
                phoneOtpPurpose: null,
              }
            : { otpFailedAttempts: attempts },
      });
      throw new BadRequestException(
        attempts >= MAX_OTP_ATTEMPTS
          ? 'Too many wrong codes. Request a new one.'
          : 'That code is not right.',
      );
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneOtpHash: null,
        phoneOtpExpiresAt: null,
        phoneOtpPurpose: null,
        otpFailedAttempts: 0,
      },
    });
  }
}
