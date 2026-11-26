import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  FineStatus,
  FineType,
  GroupMembershipStatus,
  NotificationType,
  Prisma,
  RoleName,
} from '@prisma/client';
import { dec, decN, roundMoney } from '../finance-core/money.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FinesService {
  private readonly logger = new Logger(FinesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private async membership(userId: string, groupId: string) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
    });
    if (!group || group.deletedAt)
      throw new NotFoundException(`Group ${groupId} was not found.`);
    if (!group.isVerified) {
      throw new ForbiddenException(
        'This action is only available for verified groups.',
      );
    }
    const m = await this.prisma.userGroup.findFirst({
      where: {
        userId,
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
      },
      include: { role: true },
    });
    if (!m)
      throw new ForbiddenException(
        'You are not an active member of this group.',
      );
    const isLeader =
      m.role.name === RoleName.GROUP_ADMIN ||
      m.role.name === RoleName.TREASURER;
    return { group, isLeader };
  }

  private toDto(
    f: Prisma.FineGetPayload<{
      include: { user: { select: { id: true; fullName: true } } };
    }>,
  ) {
    return {
      id: f.id,
      userId: f.userId,
      userName: f.user.fullName,
      type: f.type,
      amount: decN(f.amount),
      amountPaid: decN(f.amountPaid),
      remaining:
        f.status === FineStatus.OPEN
          ? roundMoney(decN(f.amount) - decN(f.amountPaid))
          : 0,
      currency: f.currency,
      reason: f.reason,
      status: f.status,
      contributionId: f.contributionId,
      memberLoanId: f.memberLoanId,
      issuedBySystem: f.issuedById == null,
      waivedReason: f.waivedReason,
      waivedAt: f.waivedAt?.toISOString() ?? null,
      paidAt: f.paidAt?.toISOString() ?? null,
      createdAt: f.createdAt.toISOString(),
    };
  }

  /** Leaders see every fine; members only their own. */
  async list(
    actorId: string,
    groupId: string,
    q: { status?: FineStatus; userId?: string },
  ) {
    const { isLeader } = await this.membership(actorId, groupId);
    const rows = await this.prisma.fine.findMany({
      where: {
        groupId,
        ...(q.status ? { status: q.status } : {}),
        userId: isLeader ? q.userId || undefined : actorId,
      },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, fullName: true } } },
    });
    return rows.map((f) => this.toDto(f));
  }

  async issue(
    actorId: string,
    groupId: string,
    dto: { userId: string; type: FineType; amount: number; reason: string },
  ) {
    const { group, isLeader } = await this.membership(actorId, groupId);
    if (!isLeader)
      throw new ForbiddenException(
        'Only a group admin or treasurer can issue fines.',
      );
    if (dto.userId === actorId)
      throw new ForbiddenException('You cannot fine yourself.');
    if (dto.type === FineType.LATE_CONTRIBUTION) {
      throw new BadRequestException(
        'Late-contribution fines are issued automatically.',
      );
    }
    const target = await this.prisma.userGroup.findFirst({
      where: { userId: dto.userId, groupId },
      select: { id: true },
    });
    if (!target)
      throw new NotFoundException('This user is not a member of the group.');
    const cc = await this.prisma.contributionConfig.findUnique({
      where: { groupId },
      select: { currency: true },
    });
    const fine = await this.prisma.fine.create({
      data: {
        groupId,
        userId: dto.userId,
        type: dto.type,
        amount: dec(dto.amount),
        currency: cc?.currency ?? 'RWF',
        reason: dto.reason.trim(),
        issuedById: actorId,
      },
      include: { user: { select: { id: true, fullName: true } } },
    });
    void this.notifications
      .notifyMember({
        userId: dto.userId,
        groupId,
        type: NotificationType.FINE_ISSUED,
        title: 'Fine issued',
        body: `A fine of ${dto.amount.toFixed(0)} ${fine.currency} was issued in ${group.name}: ${fine.reason}`,
        metadata: { groupName: group.name, fineId: fine.id },
      })
      .catch((e) => this.logger.error(e));
    return this.toDto(fine);
  }

  async waive(
    actorId: string,
    groupId: string,
    fineId: string,
    reason: string,
  ) {
    const { group, isLeader } = await this.membership(actorId, groupId);
    if (!isLeader)
      throw new ForbiddenException(
        'Only a group admin or treasurer can waive fines.',
      );
    const fine = await this.prisma.fine.findFirst({
      where: { id: fineId, groupId },
    });
    if (!fine) throw new NotFoundException('Fine not found.');
    if (fine.userId === actorId)
      throw new ForbiddenException('You cannot waive your own fine.');
    if (fine.status !== FineStatus.OPEN)
      throw new BadRequestException('Only an open fine can be waived.');
    const updated = await this.prisma.fine.update({
      where: { id: fineId },
      data: {
        status: FineStatus.WAIVED,
        waivedById: actorId,
        waivedReason: reason.trim(),
        waivedAt: new Date(),
      },
      include: { user: { select: { id: true, fullName: true } } },
    });
    const left = roundMoney(decN(fine.amount) - decN(fine.amountPaid));
    void this.notifications
      .notifyMember({
        userId: fine.userId,
        groupId,
        type: NotificationType.FINE_WAIVED,
        title: 'Fine waived',
        body: `Your fine of ${left.toFixed(0)} ${fine.currency} in ${group.name} was waived.`,
        metadata: { groupName: group.name, fineId },
      })
      .catch((e) => this.logger.error(e));
    return this.toDto(updated);
  }
}
