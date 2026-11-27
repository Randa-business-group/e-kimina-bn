import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NotificationChannel, NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateAnnouncementDto } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

const DAILY_LIMIT = 10;
const DAILY_SMS_LIMIT = 3;

/** Group admin broadcasts (msfts §7). */
@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(groupId: string) {
    const rows = await this.prisma.groupAnnouncement.findMany({
      where: { groupId, deletedAt: null },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });
    const authors = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.authorId))] } },
      select: { id: true, fullName: true },
    });
    const name = new Map(authors.map((a) => [a.id, a.fullName]));
    return rows.map((r) => ({
      ...r,
      authorName: name.get(r.authorId) ?? null,
    }));
  }

  async create(authorId: string, groupId: string, dto: CreateAnnouncementDto) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { name: true, deletedAt: true },
    });
    if (!group || group.deletedAt)
      throw new NotFoundException('Group not found.');
    const since = new Date(Date.now() - 24 * 3600_000);
    const recent = await this.prisma.groupAnnouncement.findMany({
      where: { groupId, createdAt: { gte: since } },
      select: { channels: true },
    });
    if (recent.length >= DAILY_LIMIT) {
      throw new BadRequestException(
        `A group can send at most ${DAILY_LIMIT} announcements a day.`,
      );
    }
    const channels = [...new Set(dto.channels ?? [])];
    if (
      channels.includes(NotificationChannel.SMS) &&
      recent.filter((r) => r.channels.includes(NotificationChannel.SMS))
        .length >= DAILY_SMS_LIMIT
    ) {
      throw new BadRequestException(
        `SMS announcements are limited to ${DAILY_SMS_LIMIT} a day. Send this one in the app and by email only.`,
      );
    }
    const row = await this.prisma.groupAnnouncement.create({
      data: {
        groupId,
        authorId,
        title: dto.title.trim(),
        body: dto.body.trim(),
        channels,
        pinned: dto.pinned ?? false,
      },
    });
    const recipients = await this.notifications.broadcastToGroup({
      groupId,
      type: NotificationType.GROUP_ANNOUNCEMENT,
      title: row.title,
      body: row.body,
      metadata: { announcementId: row.id, groupName: group.name },
      extraChannels: channels,
    });
    return this.prisma.groupAnnouncement.update({
      where: { id: row.id },
      data: { recipients },
    });
  }

  private async own(groupId: string, id: string) {
    const row = await this.prisma.groupAnnouncement.findFirst({
      where: { id, groupId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Announcement not found.');
    return row;
  }

  async setPinned(groupId: string, id: string, pinned: boolean) {
    await this.own(groupId, id);
    return this.prisma.groupAnnouncement.update({
      where: { id },
      data: { pinned },
    });
  }

  async remove(groupId: string, id: string) {
    const row = await this.own(groupId, id);
    await this.prisma.groupAnnouncement.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
    return { removed: true };
  }
}
