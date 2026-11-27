import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ContributionInterval,
  FundType,
  GroupMembershipStatus,
  NotificationType,
  SocialFundConfig,
  SocialPayout,
  SocialPayoutReason,
  SocialPayoutStatus,
} from '@prisma/client';
import { ContributionScheduleService } from '../finance-core/contribution-schedule.service';
import { GroupCashService } from '../finance-core/group-cash.service';
import {
  cycleResolver,
  socialPayoutEntry,
  writeLedger,
} from '../finance-core/ledger';
import { EPS, dec, decN, roundMoney } from '../finance-core/money.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { AccountingAccessService } from './accounting-access.service';

export interface SocialFundConfigInput {
  amount: number;
  currency?: string;
  interval: ContributionInterval;
  startDate: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  gracePeriodDays?: number;
  latePenaltyRate?: number;
  reminderDaysBefore?: number;
  maxPayoutAmount?: number | null;
  isActive?: boolean;
}

/** Social / emergency fund (ingoboka): its own contributions and leader-approved payouts. */
@Injectable()
export class SocialFundService {
  private readonly logger = new Logger(SocialFundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccountingAccessService,
    private readonly cash: GroupCashService,
    private readonly schedule: ContributionScheduleService,
    private readonly platform: PlatformSettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  private configDto(c: SocialFundConfig) {
    return {
      id: c.id,
      groupId: c.groupId,
      amount: decN(c.amount),
      currency: c.currency,
      interval: c.interval,
      startDate: c.startDate.toISOString(),
      dayOfWeek: c.dayOfWeek,
      dayOfMonth: c.dayOfMonth,
      gracePeriodDays: c.gracePeriodDays,
      latePenaltyRate:
        c.latePenaltyRate != null ? decN(c.latePenaltyRate) : null,
      reminderDaysBefore: c.reminderDaysBefore,
      maxPayoutAmount:
        c.maxPayoutAmount != null ? decN(c.maxPayoutAmount) : null,
      isActive: c.isActive,
    };
  }

  async getOverview(userId: string, groupId: string) {
    await this.access.member(userId, groupId);
    const [cfg, pos] = await Promise.all([
      this.prisma.socialFundConfig.findUnique({ where: { groupId } }),
      this.cash.getCashPosition(groupId),
    ]);
    return {
      config: cfg ? this.configDto(cfg) : null,
      balance: pos.socialBalance,
      reservedForApprovedPayouts: pos.reservedSocial,
      available: pos.socialAvailable,
    };
  }

  async upsertConfig(
    userId: string,
    groupId: string,
    dto: SocialFundConfigInput,
  ) {
    await this.access.leader(userId, groupId, 'configure the social fund');
    const startDate = new Date(dto.startDate);
    if (Number.isNaN(startDate.getTime()))
      throw new BadRequestException('Invalid startDate.');
    const data = {
      amount: dec(dto.amount),
      currency: await this.platform.assertCurrency(dto.currency),
      interval: dto.interval,
      startDate,
      dayOfWeek: dto.dayOfWeek ?? null,
      dayOfMonth: dto.dayOfMonth ?? null,
      gracePeriodDays: dto.gracePeriodDays ?? 0,
      latePenaltyRate:
        dto.latePenaltyRate != null ? dec(dto.latePenaltyRate) : null,
      reminderDaysBefore: dto.reminderDaysBefore ?? 1,
      maxPayoutAmount:
        dto.maxPayoutAmount != null ? dec(dto.maxPayoutAmount) : null,
      isActive: dto.isActive ?? true,
    };
    const cfg = await this.prisma.socialFundConfig.upsert({
      where: { groupId },
      create: { groupId, ...data },
      update: data,
    });
    await this.schedule.onConfigChanged(groupId, new Date(), FundType.SOCIAL);
    if (!cfg.isActive) {
      // Paused: drop untouched future social periods (onConfigChanged regenerates nothing).
      await this.prisma.contribution.deleteMany({
        where: {
          groupId,
          fund: FundType.SOCIAL,
          dueDate: { gt: new Date() },
          amountPaid: 0,
          allocations: { none: {} },
          fine: { is: null },
        },
      });
    }
    return this.configDto(cfg);
  }

  private async names(ids: (string | null)[]) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids.filter((x): x is string => !!x) } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  private payoutDto(p: SocialPayout, name: Map<string, string>) {
    return {
      id: p.id,
      beneficiaryUserId: p.beneficiaryUserId,
      beneficiaryName: name.get(p.beneficiaryUserId) ?? null,
      amount: decN(p.amount),
      reason: p.reason,
      description: p.description,
      status: p.status,
      requestedByName: name.get(p.requestedById) ?? null,
      approvedByName: p.approvedById
        ? (name.get(p.approvedById) ?? null)
        : null,
      approvedAt: p.approvedAt?.toISOString() ?? null,
      rejectionReason: p.rejectionReason,
      paidAt: p.paidAt?.toISOString() ?? null,
      method: p.method,
      reference: p.reference,
      createdAt: p.createdAt.toISOString(),
    };
  }

  /** Leaders see all payouts; members see the ones they requested or receive. */
  async listPayouts(
    userId: string,
    groupId: string,
    q: { status?: SocialPayoutStatus },
  ) {
    const ctx = await this.access.member(userId, groupId);
    const rows = await this.prisma.socialPayout.findMany({
      where: {
        groupId,
        ...(q.status ? { status: q.status } : {}),
        ...(ctx.isLeader || ctx.isSuperAdmin
          ? {}
          : { OR: [{ beneficiaryUserId: userId }, { requestedById: userId }] }),
      },
      orderBy: { createdAt: 'desc' },
    });
    const name = await this.names(
      rows.flatMap((r) => [
        r.beneficiaryUserId,
        r.requestedById,
        r.approvedById,
      ]),
    );
    return rows.map((r) => this.payoutDto(r, name));
  }

  async requestPayout(
    userId: string,
    groupId: string,
    dto: {
      beneficiaryUserId?: string;
      amount: number;
      reason: SocialPayoutReason;
      description: string;
    },
  ) {
    const ctx = await this.access.member(userId, groupId);
    if (ctx.isSuperAdmin && !ctx.role)
      throw new ForbiddenException('Only members can request payouts.');
    const beneficiaryUserId = dto.beneficiaryUserId || userId;
    if (beneficiaryUserId !== userId && !ctx.isLeader) {
      throw new ForbiddenException(
        'Members can only request a payout for themselves.',
      );
    }
    const member = await this.prisma.userGroup.findFirst({
      where: {
        userId: beneficiaryUserId,
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
      },
    });
    if (!member)
      throw new NotFoundException('The beneficiary is not an active member.');
    const cfg = await this.prisma.socialFundConfig.findUnique({
      where: { groupId },
    });
    if (!cfg) throw new BadRequestException('This group has no social fund.');
    if (
      cfg.maxPayoutAmount != null &&
      dto.amount - decN(cfg.maxPayoutAmount) > EPS
    ) {
      throw new BadRequestException(
        `The maximum social fund payout is ${decN(cfg.maxPayoutAmount).toFixed(0)} ${cfg.currency}.`,
      );
    }
    const cycleOf = await cycleResolver(this.prisma, groupId);
    const p = await this.prisma.socialPayout.create({
      data: {
        groupId,
        beneficiaryUserId,
        amount: dec(dto.amount),
        reason: dto.reason,
        description: dto.description.trim(),
        requestedById: userId,
        cycleId: cycleOf(new Date()),
      },
    });
    const name = await this.names([beneficiaryUserId, userId]);
    void this.notifications
      .notifyFinanceLeaders({
        groupId,
        type: NotificationType.SOCIAL_PAYOUT_REQUESTED,
        title: 'Social fund payout requested',
        body: `${name.get(beneficiaryUserId) ?? 'A member'}: ${dto.amount.toFixed(0)} ${cfg.currency} (${dto.reason.toLowerCase()}) in ${ctx.group.name}.`,
        metadata: { groupName: ctx.group.name, socialPayoutId: p.id },
        excludeUserId: userId,
      })
      .catch((e) => this.logger.error(e));
    return this.payoutDto(p, name);
  }

  private async load(groupId: string, id: string) {
    const p = await this.prisma.socialPayout.findFirst({
      where: { id, groupId },
    });
    if (!p) throw new NotFoundException('Payout not found.');
    return p;
  }

  async approve(userId: string, groupId: string, id: string) {
    const ctx = await this.access.leader(
      userId,
      groupId,
      'approve social fund payouts',
    );
    const p = await this.load(groupId, id);
    if (p.status !== SocialPayoutStatus.PENDING)
      throw new BadRequestException('This payout is not pending.');
    if (p.requestedById === userId || p.beneficiaryUserId === userId) {
      throw new ForbiddenException(
        'Another leader must approve a payout you requested or receive.',
      );
    }
    const pos = await this.cash.getCashPosition(groupId);
    if (decN(p.amount) - pos.socialAvailable > EPS) {
      throw new BadRequestException(
        `The social fund only has ${pos.socialAvailable.toFixed(0)} RWF available.`,
      );
    }
    const updated = await this.prisma.socialPayout.update({
      where: { id },
      data: {
        status: SocialPayoutStatus.APPROVED,
        approvedById: userId,
        approvedAt: new Date(),
      },
    });
    void this.notifications
      .notifyMember({
        userId: p.beneficiaryUserId,
        groupId,
        type: NotificationType.SOCIAL_PAYOUT_APPROVED,
        title: 'Social fund payout approved',
        body: `Your ${decN(p.amount).toFixed(0)} RWF social fund payout in ${ctx.group.name} was approved and will be paid soon.`,
        metadata: { groupName: ctx.group.name, socialPayoutId: id },
      })
      .catch((e) => this.logger.error(e));
    return this.payoutDto(
      updated,
      await this.names([p.beneficiaryUserId, p.requestedById, userId]),
    );
  }

  async reject(userId: string, groupId: string, id: string, reason: string) {
    const ctx = await this.access.leader(
      userId,
      groupId,
      'reject social fund payouts',
    );
    const p = await this.load(groupId, id);
    if (
      p.status !== SocialPayoutStatus.PENDING &&
      p.status !== SocialPayoutStatus.APPROVED
    ) {
      throw new BadRequestException(
        'Only a pending or approved (unpaid) payout can be rejected.',
      );
    }
    if (p.beneficiaryUserId === userId)
      throw new ForbiddenException('You cannot decide on your own payout.');
    const updated = await this.prisma.socialPayout.update({
      where: { id },
      data: {
        status: SocialPayoutStatus.REJECTED,
        rejectedById: userId,
        rejectionReason: reason.trim(),
      },
    });
    void this.notifications
      .notifyMember({
        userId: p.beneficiaryUserId,
        groupId,
        type: NotificationType.SOCIAL_PAYOUT_REJECTED,
        title: 'Social fund payout declined',
        body: `Your social fund payout request in ${ctx.group.name} was declined: ${reason.trim()}`,
        metadata: { groupName: ctx.group.name, socialPayoutId: id },
      })
      .catch((e) => this.logger.error(e));
    return this.payoutDto(
      updated,
      await this.names([p.beneficiaryUserId, p.requestedById]),
    );
  }

  async cancel(userId: string, groupId: string, id: string) {
    await this.access.member(userId, groupId);
    const p = await this.load(groupId, id);
    if (p.status !== SocialPayoutStatus.PENDING)
      throw new BadRequestException('Only a pending request can be cancelled.');
    if (p.requestedById !== userId)
      throw new ForbiddenException(
        'Only the requester can cancel this request.',
      );
    const updated = await this.prisma.socialPayout.update({
      where: { id },
      data: { status: SocialPayoutStatus.CANCELLED },
    });
    return this.payoutDto(
      updated,
      await this.names([p.beneficiaryUserId, userId]),
    );
  }

  async markPaid(
    userId: string,
    groupId: string,
    id: string,
    dto: { method: string; reference?: string },
  ) {
    const ctx = await this.access.leader(
      userId,
      groupId,
      'pay social fund payouts',
    );
    const p = await this.load(groupId, id);
    if (p.status !== SocialPayoutStatus.APPROVED)
      throw new BadRequestException('Approve the payout before paying it.');
    if (p.beneficiaryUserId === userId)
      throw new ForbiddenException('Another leader must pay your own payout.');
    const updated = await this.prisma.$transaction(async (tx) => {
      const pos = await this.cash.getCashPosition(groupId, tx);
      // Approved payouts are already reserved; check against the raw balance.
      if (decN(p.amount) - pos.socialBalance > EPS) {
        throw new BadRequestException(
          `The social fund only holds ${pos.socialBalance.toFixed(0)} RWF.`,
        );
      }
      const claimed = await tx.socialPayout.updateMany({
        where: { id, status: SocialPayoutStatus.APPROVED },
        data: {
          status: SocialPayoutStatus.PAID,
          paidById: userId,
          paidAt: new Date(),
          method: dto.method,
          reference: dto.reference?.trim() || null,
        },
      });
      if (claimed.count === 0)
        throw new BadRequestException('This payout was already paid.');
      const fresh = await tx.socialPayout.findUniqueOrThrow({ where: { id } });
      await writeLedger(tx, [socialPayoutEntry(fresh)]);
      return fresh;
    });
    void this.notifications
      .notifyMember({
        userId: p.beneficiaryUserId,
        groupId,
        type: NotificationType.SOCIAL_PAYOUT_PAID,
        title: 'Social fund payout paid',
        body: `${roundMoney(decN(p.amount)).toFixed(0)} RWF from the ${ctx.group.name} social fund was paid to you (${dto.method}).`,
        metadata: { groupName: ctx.group.name, socialPayoutId: id },
      })
      .catch((e) => this.logger.error(e));
    return this.payoutDto(
      updated,
      await this.names([p.beneficiaryUserId, p.requestedById, p.approvedById]),
    );
  }
}
