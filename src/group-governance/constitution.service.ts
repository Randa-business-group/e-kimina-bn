import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GroupMembershipStatus, NotificationType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { GovernanceAccessService } from './governance-access.service';

/** Versioned group constitution / bylaws; members accept the current version (msfts §3). */
@Injectable()
export class ConstitutionService {
  private readonly logger = new Logger(ConstitutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GovernanceAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  private latest(groupId: string) {
    return this.prisma.groupConstitution.findFirst({
      where: { groupId },
      orderBy: { version: 'desc' },
    });
  }

  /** True when there is no constitution or the user accepted the latest version. */
  async hasAcceptedCurrent(groupId: string, userId: string) {
    const c = await this.latest(groupId);
    if (!c) return true;
    const a = await this.prisma.constitutionAcceptance.findUnique({
      where: { constitutionId_userId: { constitutionId: c.id, userId } },
    });
    return a != null;
  }

  async current(actorId: string, groupId: string) {
    const ctx = await this.access.member(actorId, groupId);
    const c = await this.latest(groupId);
    if (!c) return { constitution: null, acceptedByMe: true, required: false };
    const g = await this.prisma.group.findUniqueOrThrow({
      where: { id: groupId },
      select: { constitutionRequired: true },
    });
    const accepted = await this.prisma.constitutionAcceptance.findMany({
      where: { constitutionId: c.id },
      select: { userId: true, acceptedAt: true },
    });
    let acceptance:
      | { accepted: number; pending: { userId: string; fullName: string }[] }
      | undefined;
    if (ctx.isLeader || ctx.isSuperAdmin) {
      const members = await this.prisma.userGroup.findMany({
        where: { groupId, membershipStatus: GroupMembershipStatus.ACTIVE },
        include: { user: { select: { fullName: true } } },
      });
      const done = new Set(accepted.map((a) => a.userId));
      acceptance = {
        accepted: members.filter((m) => done.has(m.userId)).length,
        pending: members
          .filter((m) => !done.has(m.userId))
          .map((m) => ({ userId: m.userId, fullName: m.user.fullName })),
      };
    }
    return {
      constitution: {
        id: c.id,
        version: c.version,
        title: c.title,
        content: c.content,
        documentUrl: c.documentUrl,
        summaryOfChanges: c.summaryOfChanges,
        publishedAt: c.createdAt.toISOString(),
      },
      required: g.constitutionRequired,
      acceptedByMe: accepted.some((a) => a.userId === actorId),
      ...(acceptance ? { acceptance } : {}),
    };
  }

  async history(actorId: string, groupId: string) {
    await this.access.member(actorId, groupId);
    const rows = await this.prisma.groupConstitution.findMany({
      where: { groupId },
      orderBy: { version: 'desc' },
      include: { _count: { select: { acceptances: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      version: c.version,
      title: c.title,
      summaryOfChanges: c.summaryOfChanges,
      documentUrl: c.documentUrl,
      publishedAt: c.createdAt.toISOString(),
      acceptances: c._count.acceptances,
    }));
  }

  async publish(
    actorId: string,
    groupId: string,
    dto: {
      title: string;
      content: string;
      documentUrl?: string;
      summaryOfChanges?: string;
    },
  ) {
    const ctx = await this.access.admin(
      actorId,
      groupId,
      'publish the constitution',
    );
    const prev = await this.latest(groupId);
    const c = await this.prisma.groupConstitution.create({
      data: {
        groupId,
        version: (prev?.version ?? 0) + 1,
        title: dto.title.trim(),
        content: dto.content.trim(),
        documentUrl: dto.documentUrl?.trim() || null,
        summaryOfChanges: dto.summaryOfChanges?.trim() || null,
        publishedById: actorId,
        acceptances: { create: { userId: actorId } },
      },
    });
    void this.notifications
      .notifyAllMembers({
        groupId,
        type: NotificationType.CONSTITUTION_PUBLISHED,
        title: prev ? 'Group rules updated' : 'Group rules published',
        body: `${ctx.group.name} published version ${c.version} of its rules${c.summaryOfChanges ? `: ${c.summaryOfChanges}` : ''}. Please read and accept them.`,
        metadata: {
          groupName: ctx.group.name,
          constitutionId: c.id,
          version: c.version,
        },
        excludeUserId: actorId,
      })
      .catch((e) => this.logger.error(e));
    return { id: c.id, version: c.version };
  }

  async accept(actorId: string, groupId: string, version?: number) {
    await this.access.context(actorId, groupId);
    const c = await this.latest(groupId);
    if (!c) throw new NotFoundException('This group has no constitution yet.');
    if (version != null && version !== c.version) {
      throw new BadRequestException(
        `Version ${c.version} is the current one; please read it before accepting.`,
      );
    }
    await this.prisma.constitutionAcceptance.upsert({
      where: {
        constitutionId_userId: { constitutionId: c.id, userId: actorId },
      },
      create: { constitutionId: c.id, userId: actorId },
      update: {},
    });
    return { version: c.version, accepted: true };
  }
}
