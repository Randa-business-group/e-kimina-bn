import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  GroupMembershipStatus,
  LedgerDirection,
  LedgerEntryType,
  NotificationType,
  PayoutMode,
  RotationSlot,
  RotationSlotStatus,
  SwapRequestStatus,
} from '@prisma/client';
import { GroupCashService } from '../finance-core/group-cash.service';
import { cycleResolver, writeLedger } from '../finance-core/ledger';
import { EPS, dec, decN, roundMoney } from '../finance-core/money.util';
import { firstDueAfter } from '../finance-core/schedule.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountingAccessService } from './accounting-access.service';

export type RotationOrder = 'JOIN_ORDER' | 'RANDOM' | 'CUSTOM';

/** Tontine / ROSCA: each due date's pot goes to one member in turn. */
@Injectable()
export class RotationService {
  private readonly logger = new Logger(RotationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccountingAccessService,
    private readonly cash: GroupCashService,
    private readonly notifications: NotificationsService,
  ) {}

  private async names(ids: string[]) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  private dto(s: RotationSlot, name: Map<string, string>) {
    return {
      id: s.id,
      position: s.position,
      dueDate: s.dueDate.toISOString(),
      recipientUserId: s.recipientUserId,
      recipientName: name.get(s.recipientUserId) ?? null,
      expectedAmount: decN(s.expectedAmount),
      status: s.status,
      paidAmount: s.paidAmount != null ? decN(s.paidAmount) : null,
      paidAt: s.paidAt?.toISOString() ?? null,
      method: s.method,
      skipReason: s.skipReason,
    };
  }

  async list(userId: string, groupId: string) {
    await this.access.member(userId, groupId);
    const [slots, swaps] = await Promise.all([
      this.prisma.rotationSlot.findMany({
        where: { groupId },
        orderBy: { dueDate: 'asc' },
      }),
      this.prisma.rotationSwapRequest.findMany({
        where: { groupId, status: SwapRequestStatus.PENDING },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const name = await this.names([
      ...slots.map((s) => s.recipientUserId),
      ...swaps.flatMap((s) => [s.requestedById, s.targetUserId]),
    ]);
    return {
      slots: slots.map((s) => this.dto(s, name)),
      pendingSwaps: swaps.map((s) => ({
        id: s.id,
        fromSlotId: s.fromSlotId,
        toSlotId: s.toSlotId,
        requestedByName: name.get(s.requestedById) ?? null,
        targetUserId: s.targetUserId,
        targetName: name.get(s.targetUserId) ?? null,
        createdAt: s.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Build the payout order on the next due dates of the savings schedule (one slot per member).
   * `replace` drops existing upcoming slots first (paid/skipped history is kept).
   */
  async generate(
    userId: string,
    groupId: string,
    dto: { order: RotationOrder; userIds?: string[]; replace?: boolean },
  ) {
    await this.access.admin(userId, groupId, 'set the rotation order');
    const cfg = await this.prisma.contributionConfig.findUnique({
      where: { groupId },
    });
    if (!cfg)
      throw new BadRequestException('Set the contribution rules first.');
    if (cfg.payoutMode !== PayoutMode.ROTATING) {
      throw new BadRequestException(
        'Switch the group to rotating payouts in the contribution rules first.',
      );
    }
    const upcoming = await this.prisma.rotationSlot.count({
      where: { groupId, status: RotationSlotStatus.UPCOMING },
    });
    if (upcoming > 0 && !dto.replace) {
      throw new BadRequestException(
        'A rotation is already planned. Pass replace=true to rebuild the upcoming slots.',
      );
    }
    const members = await this.prisma.userGroup.findMany({
      where: { groupId, membershipStatus: GroupMembershipStatus.ACTIVE },
      orderBy: { joinedAt: 'asc' },
      select: { userId: true, customContributionAmount: true },
    });
    if (members.length < 2)
      throw new BadRequestException(
        'A rotation needs at least two active members.',
      );

    let order = members.map((m) => m.userId);
    if (dto.order === 'RANDOM') {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    } else if (dto.order === 'CUSTOM') {
      const ids = dto.userIds ?? [];
      const set = new Set(order);
      if (
        ids.length !== order.length ||
        new Set(ids).size !== ids.length ||
        !ids.every((id) => set.has(id))
      ) {
        throw new BadRequestException(
          'userIds must list every active member exactly once.',
        );
      }
      order = ids;
    }

    const pot = roundMoney(
      members.reduce(
        (a, m) =>
          a +
          (m.customContributionAmount != null &&
          decN(m.customContributionAmount) > 0
            ? decN(m.customContributionAmount)
            : decN(cfg.amount)),
        0,
      ),
    );
    const schedule = {
      interval: cfg.interval,
      startDate: cfg.startDate,
      dayOfWeek: cfg.dayOfWeek,
      dayOfMonth: cfg.dayOfMonth,
    };
    // Start after the last slot that is already settled (or from today).
    const last = await this.prisma.rotationSlot.findFirst({
      where: { groupId, status: { not: RotationSlotStatus.UPCOMING } },
      orderBy: { dueDate: 'desc' },
    });
    let due = firstDueAfter(
      schedule,
      last ? last.dueDate : new Date(Date.now() - 1),
    );
    const cycleOf = await cycleResolver(this.prisma, groupId);
    const basePos = last ? last.position : 0;
    const data = order.map((recipientUserId, i) => {
      const row = {
        groupId,
        position: basePos + i + 1,
        dueDate: due,
        recipientUserId,
        expectedAmount: dec(pot),
        cycleId: cycleOf(due),
      };
      due = firstDueAfter(schedule, due);
      return row;
    });
    await this.prisma.$transaction([
      this.prisma.rotationSwapRequest.updateMany({
        where: { groupId, status: SwapRequestStatus.PENDING },
        data: { status: SwapRequestStatus.CANCELLED },
      }),
      this.prisma.rotationSlot.deleteMany({
        where: { groupId, status: RotationSlotStatus.UPCOMING },
      }),
      this.prisma.rotationSlot.createMany({ data }),
    ]);
    return this.list(userId, groupId);
  }

  private async loadSlot(groupId: string, slotId: string) {
    const s = await this.prisma.rotationSlot.findFirst({
      where: { id: slotId, groupId },
    });
    if (!s) throw new NotFoundException('Rotation slot not found.');
    return s;
  }

  async pay(
    userId: string,
    groupId: string,
    slotId: string,
    dto: { amount?: number; method: string; reference?: string },
  ) {
    const ctx = await this.access.leader(
      userId,
      groupId,
      'pay rotation payouts',
    );
    const s = await this.loadSlot(groupId, slotId);
    if (s.status !== RotationSlotStatus.UPCOMING)
      throw new BadRequestException('This slot is already settled.');
    if (s.recipientUserId === userId)
      throw new ForbiddenException(
        'Another leader must pay your own rotation payout.',
      );
    const amount = roundMoney(dto.amount ?? decN(s.expectedAmount));
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const avail = await this.cash.getAvailableCash(groupId, tx);
      if (amount - avail > EPS) {
        throw new BadRequestException(
          `The group only holds ${avail.toFixed(0)} RWF; collect this period's contributions first.`,
        );
      }
      const claimed = await tx.rotationSlot.updateMany({
        where: { id: s.id, status: RotationSlotStatus.UPCOMING },
        data: {
          status: RotationSlotStatus.PAID,
          paidAmount: dec(amount),
          paidAt: now,
          paidById: userId,
          method: dto.method,
          reference: dto.reference?.trim() || null,
        },
      });
      if (claimed.count === 0)
        throw new BadRequestException('This slot is already settled.');
      await writeLedger(tx, [
        {
          groupId,
          userId: s.recipientUserId,
          type: LedgerEntryType.ROTATION_PAYOUT,
          direction: LedgerDirection.OUT,
          amount,
          rotationSlotId: s.id,
          createdById: userId,
          occurredAt: now,
          description: `Rotation payout #${s.position} (${dto.method})`,
          sourceKey: `rotation:${s.id}`,
        },
      ]);
    });
    void this.notifications
      .notifyMember({
        userId: s.recipientUserId,
        groupId,
        type: NotificationType.ROTATION_PAYOUT_PAID,
        title: 'Your rotation payout was paid',
        body: `You received ${amount.toFixed(0)} RWF from ${ctx.group.name} (turn #${s.position}).`,
        metadata: { groupName: ctx.group.name, rotationSlotId: s.id },
      })
      .catch((e) => this.logger.error(e));
    return { id: s.id, status: RotationSlotStatus.PAID, paidAmount: amount };
  }

  async skip(userId: string, groupId: string, slotId: string, reason: string) {
    await this.access.leader(userId, groupId, 'skip rotation slots');
    const s = await this.loadSlot(groupId, slotId);
    if (s.status !== RotationSlotStatus.UPCOMING)
      throw new BadRequestException('This slot is already settled.');
    await this.prisma.rotationSlot.update({
      where: { id: s.id },
      data: { status: RotationSlotStatus.SKIPPED, skipReason: reason.trim() },
    });
    return { id: s.id, status: RotationSlotStatus.SKIPPED };
  }

  /** Recipient of one upcoming slot asks the recipient of another to swap turns. */
  async requestSwap(
    userId: string,
    groupId: string,
    dto: { fromSlotId: string; toSlotId: string },
  ) {
    const ctx = await this.access.member(userId, groupId);
    const [from, to] = await Promise.all([
      this.loadSlot(groupId, dto.fromSlotId),
      this.loadSlot(groupId, dto.toSlotId),
    ]);
    if (from.recipientUserId !== userId)
      throw new ForbiddenException('You can only offer your own turn.');
    if (
      from.status !== RotationSlotStatus.UPCOMING ||
      to.status !== RotationSlotStatus.UPCOMING
    ) {
      throw new BadRequestException('Both turns must still be upcoming.');
    }
    if (to.recipientUserId === userId)
      throw new BadRequestException('Pick another member’s turn.');
    const dup = await this.prisma.rotationSwapRequest.findFirst({
      where: {
        groupId,
        fromSlotId: from.id,
        toSlotId: to.id,
        status: SwapRequestStatus.PENDING,
      },
    });
    if (dup) throw new BadRequestException('This swap was already requested.');
    const r = await this.prisma.rotationSwapRequest.create({
      data: {
        groupId,
        fromSlotId: from.id,
        toSlotId: to.id,
        requestedById: userId,
        targetUserId: to.recipientUserId,
      },
    });
    const name = await this.names([userId]);
    void this.notifications
      .notifyMember({
        userId: to.recipientUserId,
        groupId,
        type: NotificationType.ROTATION_SWAP_REQUESTED,
        title: 'Swap request',
        body: `${name.get(userId) ?? 'A member'} wants to swap turns with you in ${ctx.group.name}: their turn on ${from.dueDate.toISOString().slice(0, 10)} for yours on ${to.dueDate.toISOString().slice(0, 10)}.`,
        metadata: { groupName: ctx.group.name, swapRequestId: r.id },
      })
      .catch((e) => this.logger.error(e));
    return { id: r.id, status: r.status };
  }

  async respondSwap(
    userId: string,
    groupId: string,
    swapId: string,
    accept: boolean,
  ) {
    const ctx = await this.access.member(userId, groupId);
    const r = await this.prisma.rotationSwapRequest.findFirst({
      where: { id: swapId, groupId },
    });
    if (!r) throw new NotFoundException('Swap request not found.');
    if (r.status !== SwapRequestStatus.PENDING)
      throw new BadRequestException('This request was already answered.');
    if (r.targetUserId !== userId)
      throw new ForbiddenException(
        'Only the member asked can answer this request.',
      );
    if (!accept) {
      await this.prisma.rotationSwapRequest.update({
        where: { id: r.id },
        data: { status: SwapRequestStatus.DECLINED, respondedAt: new Date() },
      });
    } else {
      await this.prisma.$transaction(async (tx) => {
        const [from, to] = await Promise.all([
          tx.rotationSlot.findUniqueOrThrow({ where: { id: r.fromSlotId } }),
          tx.rotationSlot.findUniqueOrThrow({ where: { id: r.toSlotId } }),
        ]);
        if (
          from.status !== RotationSlotStatus.UPCOMING ||
          to.status !== RotationSlotStatus.UPCOMING ||
          from.recipientUserId !== r.requestedById ||
          to.recipientUserId !== r.targetUserId
        ) {
          throw new BadRequestException(
            'These turns changed since the request; ask again.',
          );
        }
        await tx.rotationSlot.update({
          where: { id: from.id },
          data: { recipientUserId: to.recipientUserId },
        });
        await tx.rotationSlot.update({
          where: { id: to.id },
          data: { recipientUserId: from.recipientUserId },
        });
        await tx.rotationSwapRequest.update({
          where: { id: r.id },
          data: { status: SwapRequestStatus.ACCEPTED, respondedAt: new Date() },
        });
      });
    }
    void this.notifications
      .notifyMember({
        userId: r.requestedById,
        groupId,
        type: NotificationType.ROTATION_SWAP_RESPONDED,
        title: accept ? 'Swap accepted' : 'Swap declined',
        body: accept
          ? `Your turn swap in ${ctx.group.name} was accepted.`
          : `Your turn swap request in ${ctx.group.name} was declined.`,
        metadata: { groupName: ctx.group.name, swapRequestId: r.id },
      })
      .catch((e) => this.logger.error(e));
    return {
      id: r.id,
      status: accept ? SwapRequestStatus.ACCEPTED : SwapRequestStatus.DECLINED,
    };
  }

  async cancelSwap(userId: string, groupId: string, swapId: string) {
    await this.access.member(userId, groupId);
    const r = await this.prisma.rotationSwapRequest.findFirst({
      where: { id: swapId, groupId },
    });
    if (!r) throw new NotFoundException('Swap request not found.');
    if (r.requestedById !== userId)
      throw new ForbiddenException('Only the requester can cancel.');
    if (r.status !== SwapRequestStatus.PENDING)
      throw new BadRequestException('This request was already answered.');
    await this.prisma.rotationSwapRequest.update({
      where: { id: r.id },
      data: { status: SwapRequestStatus.CANCELLED },
    });
    return { id: r.id, status: SwapRequestStatus.CANCELLED };
  }
}
