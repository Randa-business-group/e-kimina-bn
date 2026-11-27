import { Injectable } from '@nestjs/common';
import { NotificationChannel, Prisma, SmsStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationDeliveryService } from './delivery.service';
import { CATEGORIES, categoryDefault } from './notification-catalog';
import { PushService } from './push.service';
import { SmsService, normalizePhone } from './sms.service';
import type { SmsLogQueryDto } from './dto/notifications.dto';

const CHANNELS = [
  NotificationChannel.IN_APP,
  NotificationChannel.EMAIL,
  NotificationChannel.SMS,
  NotificationChannel.PUSH,
] as const;

/** Notification preferences per user, channel and category (msfts §7). */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: NotificationDeliveryService,
    private readonly sms: SmsService,
    private readonly push: PushService,
  ) {}

  async get(userId: string) {
    const [user, prefs, devices] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true, emailVerified: true, phoneNumber: true },
      }),
      this.prisma.notificationPreference.findMany({ where: { userId } }),
      this.push.devices(userId),
    ]);
    const phone = normalizePhone(user.phoneNumber);
    const channels = {
      IN_APP: { available: true, reason: null as string | null },
      EMAIL: {
        available: this.delivery.emailAvailable && user.emailVerified,
        reason: !this.delivery.emailAvailable
          ? 'Email is not set up on this server.'
          : !user.emailVerified
            ? 'Verify your email address first.'
            : null,
        address: user.email,
      },
      SMS: {
        available: this.sms.enabled && Boolean(phone),
        reason: !this.sms.enabled
          ? 'SMS is not set up on this server.'
          : !phone
            ? 'Add a phone number to your profile to get SMS.'
            : null,
        phone: phone ? `+${phone}` : null,
      },
      PUSH: {
        available: true,
        reason: devices
          ? null
          : 'Turn on browser notifications on this device.',
        devices,
      },
    };
    return {
      channels,
      categories: CATEGORIES.map((c) => ({
        key: c.key,
        label: c.label,
        description: c.description,
        settings: Object.fromEntries(
          CHANNELS.map((ch) => {
            const row = prefs.find(
              (p) => p.channel === ch && p.category === c.key,
            );
            return [
              ch,
              {
                enabled: row ? row.enabled : categoryDefault(ch, c.key),
                isDefault: !row,
              },
            ];
          }),
        ),
      })),
    };
  }

  async update(
    userId: string,
    items: {
      category: string;
      channel: NotificationChannel;
      enabled: boolean;
    }[],
  ) {
    await this.prisma.$transaction(
      items.map((i) =>
        this.prisma.notificationPreference.upsert({
          where: {
            userId_channel_category: {
              userId,
              channel: i.channel,
              category: i.category,
            },
          },
          create: {
            userId,
            channel: i.channel,
            category: i.category,
            enabled: i.enabled,
          },
          update: { enabled: i.enabled },
        }),
      ),
    );
    return this.get(userId);
  }

  async reset(userId: string) {
    await this.prisma.notificationPreference.deleteMany({ where: { userId } });
    return this.get(userId);
  }

  /** Super admin: SMS log with filters and 30-day totals. */
  async smsLogs(q: SmsLogQueryDto) {
    const pageSize = Math.min(200, q.pageSize ?? 50);
    const page = q.page ?? 1;
    const s = q.search?.trim();
    const where: Prisma.SmsLogWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.groupId ? { groupId: q.groupId } : {}),
      ...(s
        ? {
            OR: [
              { to: { contains: s.replace(/\D/g, '') || s } },
              { message: { contains: s, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const since = new Date(Date.now() - 30 * 86400_000);
    const [total, items, byStatus, segments] = await Promise.all([
      this.prisma.smsLog.count({ where }),
      this.prisma.smsLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.smsLog.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.smsLog.aggregate({
        where: { createdAt: { gte: since }, status: SmsStatus.SENT },
        _sum: { segments: true },
      }),
    ]);
    return {
      provider: this.sms.provider,
      last30Days: {
        ...Object.fromEntries(byStatus.map((b) => [b.status, b._count._all])),
        segments: segments._sum.segments ?? 0,
      },
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      items,
    };
  }
}
