import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobQueueService } from '../jobs/job-queue.service';
import {
  NotificationChannel,
  NotificationType,
  SmsStatus,
} from '@prisma/client';
import { EmailService } from '../email/email.service.js';
import { renderTemplate } from '../email/templates/base.template.js';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEDICATED_EMAIL,
  categoryOf,
  defaultEnabled,
} from './notification-catalog';
import { PushService } from './push.service';
import { SmsService } from './sms.service';

export type DeliveryItem = {
  /** UserNotification id (null when the in-app copy was muted). */
  id: string | null;
  userId: string;
  groupId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  metadata?: object | null;
};

export type DeliveryOptions = {
  /** Restrict the outside channels to these (announcements: the author's choice). */
  onlyChannels?: NotificationChannel[];
};

type Pref = {
  userId: string;
  channel: NotificationChannel;
  category: string;
  enabled: boolean;
};

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Decides per user and channel (preference, else default) and sends email / SMS / push. */
@Injectable()
export class NotificationDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly sms: SmsService,
    private readonly push: PushService,
    private readonly queue: JobQueueService,
  ) {}

  get emailAvailable(): boolean {
    return this.emailDryRun || Boolean(process.env.SMTP_HOST?.trim());
  }

  /** NOTIFY_EMAIL_DRY_RUN=true: decide and record email deliveries without sending (staging, tests). */
  private get emailDryRun(): boolean {
    return process.env.NOTIFY_EMAIL_DRY_RUN === 'true';
  }

  static enabledFor(
    prefs: Pref[],
    userId: string,
    channel: NotificationChannel,
    type: NotificationType,
  ): boolean {
    const cat = categoryOf(type);
    const row = prefs.find(
      (p) => p.userId === userId && p.channel === channel && p.category === cat,
    );
    return row ? row.enabled : defaultEnabled(channel, type);
  }

  /** In-app preference check used before inserting rows. */
  async inAppMuted(
    userIds: string[],
    type: NotificationType,
  ): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const rows = await this.prisma.notificationPreference.findMany({
      where: {
        userId: { in: userIds },
        channel: NotificationChannel.IN_APP,
        category: categoryOf(type),
        enabled: false,
      },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }

  /** Fire-and-forget from callers; never throws. */
  async dispatch(
    items: DeliveryItem[],
    opts: DeliveryOptions = {},
  ): Promise<void> {
    if (!items.length) return;
    try {
      await this.run(items, opts);
    } catch (e) {
      this.logger.error(
        `notification delivery failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async run(items: DeliveryItem[], opts: DeliveryOptions) {
    const userIds = [...new Set(items.map((i) => i.userId))];
    const groupIds = [
      ...new Set(items.map((i) => i.groupId).filter(Boolean)),
    ] as string[];
    const [users, prefs, subs, groups] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          fullName: true,
          email: true,
          emailVerified: true,
          phoneNumber: true,
          isActive: true,
          suspendedAt: true,
        },
      }),
      this.prisma.notificationPreference.findMany({
        where: { userId: { in: userIds } },
      }),
      this.prisma.pushSubscription.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds } },
        _count: { _all: true },
      }),
      groupIds.length
        ? this.prisma.group.findMany({
            where: { id: { in: groupIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as { id: string; name: string }[]),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const hasPush = new Set(subs.map((s) => s.userId));
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const allowed = (c: NotificationChannel) =>
      !opts.onlyChannels || opts.onlyChannels.includes(c);

    // Each outside message is its own background job: retried on failure, and the channel is
    // recorded on the notification only once it really went out (msfts §10).
    for (const it of items) {
      const u = userById.get(it.userId);
      if (!u || !u.isActive || u.suspendedAt) continue;
      const group = it.groupId ? (groupName.get(it.groupId) ?? null) : null;
      const on = (c: NotificationChannel) =>
        allowed(c) &&
        NotificationDeliveryService.enabledFor(prefs, u.id, c, it.type);
      const base = { notificationId: it.id, userId: u.id, groupId: it.groupId };
      if (
        on(NotificationChannel.EMAIL) &&
        this.emailAvailable &&
        u.emailVerified &&
        !DEDICATED_EMAIL.has(it.type)
      ) {
        await this.queue.enqueue('notification.email', {
          ...base,
          to: u.email,
          fullName: u.fullName,
          title: it.title,
          body: it.body,
          group,
        });
      }
      if (on(NotificationChannel.SMS) && this.sms.enabled && u.phoneNumber) {
        await this.queue.enqueue('notification.sms', {
          ...base,
          to: u.phoneNumber,
          message: this.smsText(it, group),
          kind: it.type,
        });
      }
      if (on(NotificationChannel.PUSH) && hasPush.has(u.id)) {
        await this.queue.enqueue('notification.push', {
          ...base,
          title: it.title,
          body: group ? `${group}: ${it.body}` : it.body,
          url: '/dashboard',
          tag: it.id,
        });
      }
    }
  }

  onModuleInit() {
    this.queue.register('notification.email', async (p) => {
      await this.sendEmail(
        { email: String(p.to), fullName: String(p.fullName) },
        { title: String(p.title), body: String(p.body) },
        (p.group as string | null) ?? null,
      );
      await this.markDelivered(p.notificationId, NotificationChannel.EMAIL);
    });
    this.queue.register('notification.sms', async (p) => {
      const r = await this.sms.send({
        to: String(p.to),
        message: String(p.message),
        kind: String(p.kind),
        userId: (p.userId as string) ?? null,
        groupId: (p.groupId as string) ?? null,
      });
      if (r.status === SmsStatus.FAILED)
        throw new Error(r.error ?? 'SMS failed');
      if (r.status === SmsStatus.SENT) {
        await this.markDelivered(p.notificationId, NotificationChannel.SMS);
      }
    });
    this.queue.register('notification.push', async (p) => {
      const ok = await this.push.sendToUser(String(p.userId), {
        title: String(p.title),
        body: String(p.body),
        url: typeof p.url === 'string' ? p.url : '/dashboard',
        tag: (p.tag as string) ?? undefined,
      });
      if (ok)
        await this.markDelivered(p.notificationId, NotificationChannel.PUSH);
    });
  }

  private async markDelivered(
    notificationId: unknown,
    channel: NotificationChannel,
  ) {
    if (typeof notificationId !== 'string') return;
    await this.prisma.$executeRaw`
      UPDATE "user_notifications"
      SET "deliveredVia" = array_append("deliveredVia", ${channel}::"NotificationChannel")
      WHERE "id" = ${notificationId} AND NOT (${channel}::"NotificationChannel" = ANY("deliveredVia"))`;
  }

  smsText(
    it: Pick<DeliveryItem, 'title' | 'body'>,
    group: string | null,
  ): string {
    const text =
      `E-kimina${group ? ` (${group})` : ''}: ${it.title}. ${it.body}`
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > 306 ? `${text.slice(0, 303)}...` : text;
  }

  /** Throws on failure so the job is retried. */
  private async sendEmail(
    u: { email: string; fullName: string },
    it: { title: string; body: string },
    group: string | null,
  ): Promise<void> {
    if (this.emailDryRun) {
      this.logger.debug(`[email dry-run] ${u.email}: ${it.title}`);
      return;
    }
    const app = (process.env.FRONTEND_URL || 'http://localhost:3033').replace(
      /\/+$/,
      '',
    );
    const html = renderTemplate(
      `<h2 style="color:#0E7A4D;margin-bottom:12px;">${esc(it.title)}</h2>
       <p>Hello ${esc(u.fullName.split(/\s+/)[0] || u.fullName)},</p>
       <p style="white-space:pre-line;">${esc(it.body)}</p>
       ${group ? `<p style="color:#64748b;font-size:13px;">Group: ${esc(group)}</p>` : ''}
       <p style="margin:24px 0;"><a href="${app}/dashboard" style="background:#0E7A4D;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">Open E-kimina</a></p>
       <p style="color:#94a3b8;font-size:12px;">You can choose which messages you get by email in Settings → Notifications.</p>`,
      { subject: it.title },
    );
    await this.email.deliverNow({
      to: u.email,
      subject: group ? `${it.title} · ${group}` : it.title,
      html,
    });
  }
}
