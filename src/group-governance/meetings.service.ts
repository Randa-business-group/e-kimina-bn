import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AttendanceStatus,
  FineStatus,
  FineType,
  GroupMembershipStatus,
  Meeting,
  MeetingStatus,
  NotificationType,
} from '@prisma/client';
import { cycleResolver } from '../finance-core/ledger';
import { EPS, dec, decN } from '../finance-core/money.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { GovernanceAccessService } from './governance-access.service';

export interface MeetingInput {
  title: string;
  scheduledAt: string;
  location?: string;
  agenda?: string;
  absenceFine?: number | null;
  lateFine?: number | null;
}

/** Meetings, attendance, absence / lateness fines and minutes (msfts §3). */
@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GovernanceAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  private dto(m: Meeting, extra: Record<string, unknown> = {}) {
    return {
      id: m.id,
      title: m.title,
      scheduledAt: m.scheduledAt.toISOString(),
      location: m.location,
      agenda: m.agenda,
      status: m.status,
      minutesText: m.minutesText,
      minutesUrl: m.minutesUrl,
      absenceFine: m.absenceFine != null ? decN(m.absenceFine) : null,
      lateFine: m.lateFine != null ? decN(m.lateFine) : null,
      heldAt: m.heldAt?.toISOString() ?? null,
      finesIssuedAt: m.finesIssuedAt?.toISOString() ?? null,
      cancelledReason: m.cancelledReason,
      ...extra,
    };
  }

  async list(
    actorId: string,
    groupId: string,
    scope: 'upcoming' | 'past' | 'all' = 'all',
  ) {
    await this.access.member(actorId, groupId);
    const now = new Date();
    const rows = await this.prisma.meeting.findMany({
      where: {
        groupId,
        ...(scope === 'upcoming'
          ? { scheduledAt: { gte: now }, status: MeetingStatus.SCHEDULED }
          : {}),
        ...(scope === 'past'
          ? {
              OR: [
                { scheduledAt: { lt: now } },
                { status: { not: MeetingStatus.SCHEDULED } },
              ],
            }
          : {}),
      },
      orderBy: { scheduledAt: scope === 'upcoming' ? 'asc' : 'desc' },
      include: { attendance: { select: { userId: true, status: true } } },
    });
    return rows.map((m) =>
      this.dto(m, {
        myAttendance:
          m.attendance.find((a) => a.userId === actorId)?.status ?? null,
        counts: Object.fromEntries(
          Object.values(AttendanceStatus).map((s) => [
            s,
            m.attendance.filter((a) => a.status === s).length,
          ]),
        ),
      }),
    );
  }

  private async load(groupId: string, meetingId: string) {
    const m = await this.prisma.meeting.findFirst({
      where: { id: meetingId, groupId },
    });
    if (!m) throw new NotFoundException('Meeting not found.');
    return m;
  }

  async get(actorId: string, groupId: string, meetingId: string) {
    await this.access.member(actorId, groupId);
    const m = await this.load(groupId, meetingId);
    const att = await this.prisma.meetingAttendance.findMany({
      where: { meetingId },
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: att.map((a) => a.userId) } },
      select: { id: true, fullName: true },
    });
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    return this.dto(m, {
      attendance: att.map((a) => ({
        userId: a.userId,
        fullName: name.get(a.userId) ?? null,
        status: a.status,
        note: a.note,
        fined: a.fineId != null,
      })),
    });
  }

  async create(actorId: string, groupId: string, dto: MeetingInput) {
    const ctx = await this.access.leader(actorId, groupId, 'schedule meetings');
    const at = new Date(dto.scheduledAt);
    if (Number.isNaN(at.getTime()))
      throw new BadRequestException('Invalid scheduledAt.');
    const m = await this.prisma.meeting.create({
      data: {
        groupId,
        title: dto.title.trim(),
        scheduledAt: at,
        location: dto.location?.trim() || null,
        agenda: dto.agenda?.trim() || null,
        absenceFine: dto.absenceFine != null ? dec(dto.absenceFine) : null,
        lateFine: dto.lateFine != null ? dec(dto.lateFine) : null,
        createdById: actorId,
      },
    });
    void this.notifications
      .notifyAllMembers({
        groupId,
        type: NotificationType.MEETING_SCHEDULED,
        title: 'Meeting scheduled',
        body: `${m.title} — ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC${m.location ? ` at ${m.location}` : ''} (${ctx.group.name}).`,
        metadata: { groupName: ctx.group.name, meetingId: m.id },
      })
      .catch((e) => this.logger.error(e));
    return this.dto(m);
  }

  async update(
    actorId: string,
    groupId: string,
    meetingId: string,
    dto: Partial<MeetingInput>,
  ) {
    await this.access.leader(actorId, groupId, 'edit meetings');
    const m = await this.load(groupId, meetingId);
    if (m.status !== MeetingStatus.SCHEDULED)
      throw new BadRequestException('Only a scheduled meeting can be edited.');
    const at = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;
    if (at && Number.isNaN(at.getTime()))
      throw new BadRequestException('Invalid scheduledAt.');
    const u = await this.prisma.meeting.update({
      where: { id: meetingId },
      data: {
        ...(dto.title ? { title: dto.title.trim() } : {}),
        ...(at ? { scheduledAt: at } : {}),
        ...(dto.location !== undefined
          ? { location: dto.location?.trim() || null }
          : {}),
        ...(dto.agenda !== undefined
          ? { agenda: dto.agenda?.trim() || null }
          : {}),
        ...(dto.absenceFine !== undefined
          ? {
              absenceFine:
                dto.absenceFine != null ? dec(dto.absenceFine) : null,
            }
          : {}),
        ...(dto.lateFine !== undefined
          ? { lateFine: dto.lateFine != null ? dec(dto.lateFine) : null }
          : {}),
      },
    });
    return this.dto(u);
  }

  async cancel(
    actorId: string,
    groupId: string,
    meetingId: string,
    reason: string,
  ) {
    const ctx = await this.access.leader(actorId, groupId, 'cancel meetings');
    const m = await this.load(groupId, meetingId);
    if (m.status !== MeetingStatus.SCHEDULED)
      throw new BadRequestException(
        'Only a scheduled meeting can be cancelled.',
      );
    const u = await this.prisma.meeting.update({
      where: { id: meetingId },
      data: { status: MeetingStatus.CANCELLED, cancelledReason: reason.trim() },
    });
    void this.notifications
      .notifyAllMembers({
        groupId,
        type: NotificationType.MEETING_CANCELLED,
        title: 'Meeting cancelled',
        body: `${m.title} (${ctx.group.name}) is cancelled: ${reason.trim()}`,
        metadata: { groupName: ctx.group.name, meetingId },
      })
      .catch((e) => this.logger.error(e));
    return this.dto(u);
  }

  /** Record (or correct) attendance; the meeting becomes HELD. */
  async recordAttendance(
    actorId: string,
    groupId: string,
    meetingId: string,
    entries: { userId: string; status: AttendanceStatus; note?: string }[],
  ) {
    await this.access.leader(actorId, groupId, 'record attendance');
    const m = await this.load(groupId, meetingId);
    if (m.status === MeetingStatus.CANCELLED)
      throw new BadRequestException('This meeting was cancelled.');
    if (m.scheduledAt > new Date(Date.now() + 6 * 3_600_000)) {
      throw new BadRequestException(
        'Attendance can be recorded from the day of the meeting.',
      );
    }
    const members = await this.prisma.userGroup.findMany({
      where: { groupId, membershipStatus: GroupMembershipStatus.ACTIVE },
      select: { userId: true },
    });
    const valid = new Set(members.map((x) => x.userId));
    const bad = entries.find((e) => !valid.has(e.userId));
    if (bad)
      throw new BadRequestException(
        `User ${bad.userId} is not an active member.`,
      );
    for (const e of entries) {
      const existing = await this.prisma.meetingAttendance.findUnique({
        where: { meetingId_userId: { meetingId, userId: e.userId } },
      });
      if (existing?.fineId && existing.status !== e.status) {
        throw new BadRequestException(
          'Attendance with an issued fine cannot be changed; waive the fine first.',
        );
      }
      await this.prisma.meetingAttendance.upsert({
        where: { meetingId_userId: { meetingId, userId: e.userId } },
        create: {
          meetingId,
          userId: e.userId,
          status: e.status,
          note: e.note?.trim() || null,
          recordedById: actorId,
        },
        update: {
          status: e.status,
          note: e.note?.trim() || null,
          recordedById: actorId,
        },
      });
    }
    await this.prisma.meeting.update({
      where: { id: meetingId },
      data: { status: MeetingStatus.HELD, heldAt: m.heldAt ?? new Date() },
    });
    return this.get(actorId, groupId, meetingId);
  }

  /**
   * Issue absence / lateness fines once (meeting amounts, else group defaults). Members with no
   * attendance record are marked ABSENT first when `markMissingAbsent` is true.
   */
  async issueFines(
    actorId: string,
    groupId: string,
    meetingId: string,
    markMissingAbsent = true,
  ) {
    const ctx = await this.access.leader(
      actorId,
      groupId,
      'issue meeting fines',
    );
    const m = await this.load(groupId, meetingId);
    if (m.status !== MeetingStatus.HELD)
      throw new BadRequestException('Record attendance first.');
    const g = await this.prisma.group.findUniqueOrThrow({
      where: { id: groupId },
    });
    const absenceAmount = decN(m.absenceFine ?? g.defaultAbsenceFine);
    const lateAmount = decN(m.lateFine ?? g.defaultLateArrivalFine);
    if (markMissingAbsent) {
      const members = await this.prisma.userGroup.findMany({
        where: {
          groupId,
          membershipStatus: GroupMembershipStatus.ACTIVE,
          joinedAt: { lte: m.scheduledAt },
        },
        select: { userId: true },
      });
      const recorded = new Set(
        (
          await this.prisma.meetingAttendance.findMany({
            where: { meetingId },
            select: { userId: true },
          })
        ).map((a) => a.userId),
      );
      const missing = members.filter((x) => !recorded.has(x.userId));
      if (missing.length) {
        await this.prisma.meetingAttendance.createMany({
          data: missing.map((x) => ({
            meetingId,
            userId: x.userId,
            status: AttendanceStatus.ABSENT,
            recordedById: actorId,
            note: 'No attendance recorded',
          })),
          skipDuplicates: true,
        });
      }
    }
    const cycleOf = await cycleResolver(this.prisma, groupId);
    const day = m.scheduledAt.toISOString().slice(0, 10);
    const att = await this.prisma.meetingAttendance.findMany({
      where: {
        meetingId,
        fineId: null,
        status: { in: [AttendanceStatus.ABSENT, AttendanceStatus.LATE] },
      },
    });
    let issued = 0;
    let total = 0;
    for (const a of att) {
      const absent = a.status === AttendanceStatus.ABSENT;
      const amount = absent ? absenceAmount : lateAmount;
      if (amount < EPS) continue;
      const fine = await this.prisma.fine.create({
        data: {
          groupId,
          userId: a.userId,
          type: absent ? FineType.ABSENCE : FineType.LATE_ARRIVAL,
          amount: dec(amount),
          reason: `${absent ? 'Absent from' : 'Late to'} “${m.title}” on ${day}`,
          status: FineStatus.OPEN,
          cycleId: cycleOf(m.scheduledAt),
        },
      });
      await this.prisma.meetingAttendance.update({
        where: { id: a.id },
        data: { fineId: fine.id },
      });
      issued++;
      total += amount;
      void this.notifications
        .notifyMember({
          userId: a.userId,
          groupId,
          type: NotificationType.FINE_ISSUED,
          title: 'Meeting fine',
          body: `${fine.reason}: ${amount.toFixed(0)} RWF fine in ${ctx.group.name}.`,
          metadata: { groupName: ctx.group.name, fineId: fine.id, meetingId },
        })
        .catch((e) => this.logger.error(e));
    }
    await this.prisma.meeting.update({
      where: { id: meetingId },
      data: { finesIssuedAt: new Date() },
    });
    return {
      meetingId,
      finesIssued: issued,
      total,
      absenceFine: absenceAmount,
      lateFine: lateAmount,
    };
  }

  async publishMinutes(
    actorId: string,
    groupId: string,
    meetingId: string,
    dto: { minutesText?: string; minutesUrl?: string },
  ) {
    const ctx = await this.access.leader(actorId, groupId, 'publish minutes');
    const m = await this.load(groupId, meetingId);
    if (m.status !== MeetingStatus.HELD)
      throw new BadRequestException(
        'Minutes can be added after the meeting is held.',
      );
    if (!dto.minutesText?.trim() && !dto.minutesUrl?.trim()) {
      throw new BadRequestException(
        'Provide the minutes text or an uploaded document URL.',
      );
    }
    const u = await this.prisma.meeting.update({
      where: { id: meetingId },
      data: {
        minutesText: dto.minutesText?.trim() || m.minutesText,
        minutesUrl: dto.minutesUrl?.trim() || m.minutesUrl,
      },
    });
    void this.notifications
      .notifyAllMembers({
        groupId,
        type: NotificationType.MEETING_MINUTES_PUBLISHED,
        title: 'Meeting minutes available',
        body: `Minutes of “${m.title}” (${ctx.group.name}) are available.`,
        metadata: { groupName: ctx.group.name, meetingId },
      })
      .catch((e) => this.logger.error(e));
    return this.dto(u);
  }
}
