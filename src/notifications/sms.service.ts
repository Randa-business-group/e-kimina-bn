import { Injectable, Logger } from '@nestjs/common';
import { SmsStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type SmsProvider = 'mock' | 'africastalking' | 'http' | 'disabled';

export type SmsRequest = {
  to: string;
  message: string;
  kind: string;
  userId?: string | null;
  groupId?: string | null;
  /** What to store in the log instead of the real text (one-time codes). */
  logMessage?: string;
};

export type SmsResult = { status: SmsStatus; id?: string; error?: string };

const env = (k: string) => (process.env[k] ?? '').trim();

/** Rwanda MSISDN in international format without '+', or null. */
export function normalizePhone(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  let out = d;
  if (/^07\d{8}$/.test(d)) out = `250${d.slice(1)}`;
  else if (/^7\d{8}$/.test(d)) out = `250${d}`;
  else if (/^00\d{10,14}$/.test(d)) out = d.slice(2);
  return /^\d{10,15}$/.test(out) ? out : null;
}

export function smsSegments(text: string): number {
  return text.length <= 160 ? 1 : Math.ceil(text.length / 153);
}

/**
 * SMS gateway (msfts §7). SMS_PROVIDER:
 *  - `mock`           (default outside production) nothing is sent; the attempt is logged as SENT
 *  - `africastalking` AT_USERNAME, AT_API_KEY, optional AT_SENDER_ID (username `sandbox` uses the sandbox)
 *  - `http`           SMS_HTTP_URL (+ SMS_HTTP_TOKEN): POST JSON { to, message, sender }
 *  - `disabled`       (default in production without settings)
 * SMS_DAILY_LIMIT_PER_USER (default 20) caps notification SMS per person per day.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  /** Mock provider only (never in production): the real texts, for developers and tests. */
  private readonly inbox: {
    to: string;
    message: string;
    kind: string;
    at: string;
  }[] = [];

  get mockInboxAvailable(): boolean {
    return this.provider === 'mock' && process.env.NODE_ENV !== 'production';
  }

  mockInbox(to?: string) {
    const key = to ? normalizePhone(to) : null;
    return this.inbox
      .filter((m) => !key || m.to === key)
      .slice(-50)
      .reverse();
  }

  constructor(private readonly prisma: PrismaService) {}

  get provider(): SmsProvider {
    const p = env('SMS_PROVIDER').toLowerCase();
    if (p === 'mock' || p === 'disabled') return p;
    if (p === 'africastalking' && env('AT_USERNAME') && env('AT_API_KEY'))
      return p;
    if (p === 'http' && env('SMS_HTTP_URL')) return p;
    if (p) return 'disabled';
    return process.env.NODE_ENV === 'production' ? 'disabled' : 'mock';
  }

  get enabled(): boolean {
    return this.provider !== 'disabled';
  }

  private get dailyLimit(): number {
    const n = Number(env('SMS_DAILY_LIMIT_PER_USER'));
    return Number.isInteger(n) && n > 0 ? n : 20;
  }

  private async log(
    r: SmsRequest,
    to: string,
    status: SmsStatus,
    extra: { id?: string; error?: string } = {},
  ) {
    const text = r.logMessage ?? r.message;
    await this.prisma.smsLog
      .create({
        data: {
          userId: r.userId ?? null,
          groupId: r.groupId ?? null,
          to,
          message: text.slice(0, 1000),
          kind: r.kind,
          provider: this.provider,
          status,
          segments: smsSegments(r.message),
          providerMessageId: extra.id ?? null,
          error: extra.error?.slice(0, 500) ?? null,
        },
      })
      .catch((e: unknown) => this.logger.error(`sms log failed: ${String(e)}`));
  }

  /** Never throws. */
  async send(r: SmsRequest): Promise<SmsResult> {
    const to = normalizePhone(r.to);
    if (!to) {
      await this.log(r, r.to, SmsStatus.SKIPPED, {
        error: 'invalid phone number',
      });
      return { status: SmsStatus.SKIPPED, error: 'invalid phone number' };
    }
    if (!this.enabled) {
      await this.log(r, to, SmsStatus.SKIPPED, {
        error: 'SMS is not configured',
      });
      return { status: SmsStatus.SKIPPED, error: 'SMS is not configured' };
    }
    if (r.userId && !r.kind.startsWith('OTP_')) {
      const since = new Date(Date.now() - 24 * 3600_000);
      const sent = await this.prisma.smsLog.count({
        where: {
          userId: r.userId,
          status: SmsStatus.SENT,
          createdAt: { gte: since },
          kind: { not: { startsWith: 'OTP_' } },
        },
      });
      if (sent >= this.dailyLimit) {
        await this.log(r, to, SmsStatus.SKIPPED, {
          error: 'daily SMS limit reached',
        });
        return { status: SmsStatus.SKIPPED, error: 'daily SMS limit reached' };
      }
    }
    try {
      const id = await this.deliver(to, r.message);
      await this.log(r, to, SmsStatus.SENT, { id });
      return { status: SmsStatus.SENT, id };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.logger.warn(`SMS to ${to} failed: ${error}`);
      await this.log(r, to, SmsStatus.FAILED, { error });
      return { status: SmsStatus.FAILED, error };
    }
  }

  private async deliver(
    to: string,
    message: string,
  ): Promise<string | undefined> {
    switch (this.provider) {
      case 'mock':
        if (this.mockInboxAvailable) {
          this.inbox.push({
            to,
            message,
            kind: 'mock',
            at: new Date().toISOString(),
          });
          if (this.inbox.length > 500)
            this.inbox.splice(0, this.inbox.length - 500);
        }
        return `mock-${Date.now().toString(36)}`;
      case 'africastalking': {
        const user = env('AT_USERNAME');
        const base =
          user === 'sandbox'
            ? 'https://api.sandbox.africastalking.com'
            : 'https://api.africastalking.com';
        const form = new URLSearchParams({
          username: user,
          to: `+${to}`,
          message,
        });
        if (env('AT_SENDER_ID')) form.set('from', env('AT_SENDER_ID'));
        const res = await fetch(`${base}/version1/messaging`, {
          method: 'POST',
          headers: {
            apiKey: env('AT_API_KEY'),
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await res.json().catch(() => null)) as {
          SMSMessageData?: {
            Recipients?: { status?: string; messageId?: string }[];
            Message?: string;
          };
        } | null;
        const rec = body?.SMSMessageData?.Recipients?.[0];
        if (!res.ok || !rec || !/success|sent/i.test(rec.status ?? '')) {
          throw new Error(
            rec?.status ??
              body?.SMSMessageData?.Message ??
              `HTTP ${res.status}`,
          );
        }
        return rec.messageId;
      }
      case 'http': {
        const res = await fetch(env('SMS_HTTP_URL'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(env('SMS_HTTP_TOKEN')
              ? { Authorization: `Bearer ${env('SMS_HTTP_TOKEN')}` }
              : {}),
          },
          body: JSON.stringify({
            to: `+${to}`,
            message,
            sender: env('SMS_SENDER_ID') || 'E-kimina',
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json().catch(() => null)) as {
          id?: string;
          messageId?: string;
        } | null;
        return body?.id ?? body?.messageId;
      }
      default:
        throw new Error('SMS is not configured');
    }
  }
}
