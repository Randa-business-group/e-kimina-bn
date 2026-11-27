import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { openSecret, sealSecret } from '../common/secret-box';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { generateVapidKeys, sendWebPush, type VapidKeys } from './web-push';

/** Push services browsers use; anything else is refused (the server POSTs to this URL). */
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /(^|\.)push\.apple\.com$/,
];

export type PushMessage = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

/** Browser push notifications (msfts §7, P2). VAPID keys are created on first use. */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private keys: VapidKeys | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  private get subject(): string {
    const s = process.env.VAPID_SUBJECT?.trim();
    return (
      s ||
      `mailto:${process.env.SMTP_FROM_EMAIL?.trim() || 'support@ekimina.local'}`
    );
  }

  async vapidKeys(): Promise<VapidKeys> {
    if (this.keys) return this.keys;
    const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
    const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
    if (envPub && envPriv)
      return (this.keys = { publicKey: envPub, privateKey: envPriv });
    await this.settings.get();
    const row = await this.prisma.platformSettings.findUniqueOrThrow({
      where: { id: 'platform' },
    });
    const priv = openSecret(row.vapidPrivateKeyEnc);
    if (row.vapidPublicKey && priv)
      return (this.keys = { publicKey: row.vapidPublicKey, privateKey: priv });
    const fresh = generateVapidKeys();
    // Only the first writer wins, so concurrent first calls agree on one key pair.
    await this.prisma.platformSettings.updateMany({
      where: { id: 'platform', vapidPublicKey: null },
      data: {
        vapidPublicKey: fresh.publicKey,
        vapidPrivateKeyEnc: sealSecret(fresh.privateKey),
      },
    });
    const saved = await this.prisma.platformSettings.findUniqueOrThrow({
      where: { id: 'platform' },
    });
    return (this.keys = {
      publicKey: saved.vapidPublicKey!,
      privateKey: openSecret(saved.vapidPrivateKeyEnc)!,
    });
  }

  private allowed(endpoint: string): boolean {
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      return false;
    }
    if (
      process.env.PUSH_ALLOW_INSECURE_ENDPOINTS === 'true' &&
      ['localhost', '127.0.0.1'].includes(u.hostname)
    ) {
      return true;
    }
    if (u.protocol !== 'https:') return false;
    const extra = (process.env.PUSH_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    const host = u.hostname.toLowerCase();
    return PUSH_HOSTS.some((re) => re.test(host)) || extra.includes(host);
  }

  async subscribe(
    userId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent?: string,
  ) {
    if (!this.allowed(sub.endpoint)) {
      throw new BadRequestException('This push endpoint is not supported.');
    }
    if (
      Buffer.from(sub.keys.p256dh, 'base64url').length !== 65 ||
      Buffer.from(sub.keys.auth, 'base64url').length < 16
    ) {
      throw new BadRequestException('Invalid push subscription keys.');
    }
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: userAgent?.slice(0, 300),
      },
      update: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        failures: 0,
        userAgent: userAgent?.slice(0, 300),
      },
    });
    return {
      subscribed: true,
      devices: await this.prisma.pushSubscription.count({ where: { userId } }),
    };
  }

  async unsubscribe(userId: string, endpoint?: string) {
    const r = await this.prisma.pushSubscription.deleteMany({
      where: { userId, ...(endpoint ? { endpoint } : {}) },
    });
    return { removed: r.count };
  }

  devices(userId: string) {
    return this.prisma.pushSubscription.count({ where: { userId } });
  }

  /** Sends to every device of the user; true when at least one accepted it. */
  async sendToUser(userId: string, msg: PushMessage): Promise<boolean> {
    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId },
    });
    if (!subs.length) return false;
    const keys = await this.vapidKeys();
    let any = false;
    for (const s of subs) {
      try {
        const r = await sendWebPush(s, msg, keys, this.subject);
        if (r.ok) {
          any = true;
          await this.prisma.pushSubscription.update({
            where: { id: s.id },
            data: { lastUsedAt: new Date(), failures: 0 },
          });
        } else if (r.gone || s.failures >= 4) {
          await this.prisma.pushSubscription
            .delete({ where: { id: s.id } })
            .catch(() => undefined);
        } else {
          await this.prisma.pushSubscription.update({
            where: { id: s.id },
            data: { failures: { increment: 1 } },
          });
        }
      } catch (e) {
        this.logger.warn(
          `push to ${new URL(s.endpoint).host} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        await this.prisma.pushSubscription
          .update({ where: { id: s.id }, data: { failures: { increment: 1 } } })
          .catch(() => undefined);
      }
    }
    return any;
  }
}
