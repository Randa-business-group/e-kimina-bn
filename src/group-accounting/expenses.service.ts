import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalEntityType,
  Expense,
  ExpenseCategory,
  ExpenseStatus,
  FundType,
  GroupMembershipStatus,
  NotificationType,
  RoleName,
} from '@prisma/client';
import { GroupCashService } from '../finance-core/group-cash.service';
import {
  cycleResolver,
  expenseEntry,
  writeLedger,
} from '../finance-core/ledger';
import { EPS, dec, decN } from '../finance-core/money.util';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountingAccessService } from './accounting-access.service';

/** Group spending: recorded by one leader, approved (and paid) by another. */
@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccountingAccessService,
    private readonly cash: GroupCashService,
    private readonly notifications: NotificationsService,
  ) {}

  private async names(ids: (string | null)[]) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids.filter((x): x is string => !!x) } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  private toDto(e: Expense, name: Map<string, string>) {
    return {
      id: e.id,
      fund: e.fund,
      amount: decN(e.amount),
      category: e.category,
      description: e.description,
      receiptUrl: e.receiptUrl,
      status: e.status,
      occurredAt: e.occurredAt.toISOString(),
      cycleId: e.cycleId,
      requestedById: e.requestedById,
      requestedByName: name.get(e.requestedById) ?? null,
      approvedByName: e.approvedById
        ? (name.get(e.approvedById) ?? null)
        : null,
      approvedAt: e.approvedAt?.toISOString() ?? null,
      rejectionReason: e.rejectionReason,
      createdAt: e.createdAt.toISOString(),
    };
  }

  async list(
    userId: string,
    groupId: string,
    q: { status?: ExpenseStatus; cycleId?: string },
  ) {
    await this.access.reader(userId, groupId);
    const rows = await this.prisma.expense.findMany({
      where: {
        groupId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.cycleId ? { cycleId: q.cycleId } : {}),
      },
      orderBy: { occurredAt: 'desc' },
    });
    const name = await this.names(
      rows.flatMap((r) => [r.requestedById, r.approvedById]),
    );
    return rows.map((r) => this.toDto(r, name));
  }

  async create(
    userId: string,
    groupId: string,
    dto: {
      amount: number;
      category: ExpenseCategory;
      description: string;
      receiptUrl?: string;
      occurredAt?: string;
      fund?: FundType;
    },
  ) {
    const ctx = await this.access.leader(userId, groupId, 'record expenses');
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    if (
      Number.isNaN(occurredAt.getTime()) ||
      occurredAt > new Date(Date.now() + 86_400_000)
    ) {
      throw new BadRequestException('Invalid expense date.');
    }
    const cycleOf = await cycleResolver(this.prisma, groupId);
    const e = await this.prisma.expense.create({
      data: {
        groupId,
        fund: dto.fund ?? FundType.SAVINGS,
        amount: dec(dto.amount),
        category: dto.category,
        description: dto.description.trim(),
        receiptUrl: dto.receiptUrl?.trim() || null,
        requestedById: userId,
        occurredAt,
        cycleId: cycleOf(occurredAt),
      },
    });
    void this.notifications
      .notifyFinanceLeaders({
        groupId,
        type: NotificationType.EXPENSE_SUBMITTED,
        title: 'Expense to approve',
        body: `${dto.amount.toFixed(0)} RWF for ${dto.category.toLowerCase().replace('_', ' ')} (“${e.description}”) in ${ctx.group.name} needs your approval.`,
        metadata: { groupName: ctx.group.name, expenseId: e.id },
        excludeUserId: userId,
      })
      .catch((err) => this.logger.error(err));
    return this.toDto(e, await this.names([userId]));
  }

  private async loadPending(groupId: string, expenseId: string) {
    const e = await this.prisma.expense.findFirst({
      where: { id: expenseId, groupId },
    });
    if (!e) throw new NotFoundException('Expense not found.');
    if (e.status !== ExpenseStatus.PENDING)
      throw new BadRequestException('This expense is no longer pending.');
    return e;
  }

  async approve(userId: string, groupId: string, expenseId: string) {
    const ctx = await this.access.leader(userId, groupId, 'approve expenses');
    const e = await this.loadPending(groupId, expenseId);
    if (e.requestedById === userId) {
      throw new ForbiddenException(
        'Another leader must approve an expense you recorded.',
      );
    }
    // Co-signers: record this approval; pay out once enough leaders signed.
    const already = await this.prisma.approval.findUnique({
      where: {
        entityType_entityId_userId: {
          entityType: ApprovalEntityType.EXPENSE,
          entityId: e.id,
          userId,
        },
      },
    });
    if (already)
      throw new BadRequestException('Your approval is already on file.');
    await this.prisma.approval.create({
      data: {
        groupId,
        entityType: ApprovalEntityType.EXPENSE,
        entityId: e.id,
        userId,
        role: ctx.role ?? RoleName.TREASURER,
      },
    });
    const [group, approvals, otherLeaders] = await Promise.all([
      this.prisma.group.findUniqueOrThrow({
        where: { id: groupId },
        select: { expenseApprovalsRequired: true },
      }),
      this.prisma.approval.count({
        where: { entityType: ApprovalEntityType.EXPENSE, entityId: e.id },
      }),
      this.prisma.userGroup.count({
        where: {
          groupId,
          userId: { not: e.requestedById },
          membershipStatus: GroupMembershipStatus.ACTIVE,
          role: { name: { in: [RoleName.GROUP_ADMIN, RoleName.TREASURER] } },
        },
      }),
    ]);
    const required = Math.max(
      1,
      Math.min(group.expenseApprovalsRequired, otherLeaders),
    );
    if (approvals < required) {
      return {
        ...this.toDto(e, await this.names([e.requestedById])),
        approvals,
        approvalsRequired: required,
        message: `Approval recorded (${approvals}/${required}).`,
      };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const pos = await this.cash.getCashPosition(groupId, tx);
      const avail =
        e.fund === FundType.SOCIAL ? pos.socialAvailable : pos.available;
      if (decN(e.amount) - avail > EPS) {
        throw new BadRequestException(
          `The ${e.fund === FundType.SOCIAL ? 'social fund' : 'group'} only has ${avail.toFixed(0)} RWF available.`,
        );
      }
      const claimed = await tx.expense.updateMany({
        where: { id: e.id, status: ExpenseStatus.PENDING },
        data: {
          status: ExpenseStatus.APPROVED,
          approvedById: userId,
          approvedAt: new Date(),
        },
      });
      if (claimed.count === 0)
        throw new BadRequestException('This expense is no longer pending.');
      const fresh = await tx.expense.findUniqueOrThrow({ where: { id: e.id } });
      await writeLedger(tx, [expenseEntry(fresh)]);
      return fresh;
    });
    void this.notifications
      .notifyFinanceLeaders({
        groupId,
        type: NotificationType.EXPENSE_APPROVED,
        title: 'Expense approved',
        body: `${decN(e.amount).toFixed(0)} RWF expense (“${e.description}”) was approved in ${ctx.group.name}.`,
        metadata: { groupName: ctx.group.name, expenseId: e.id },
        excludeUserId: userId,
      })
      .catch((err) => this.logger.error(err));
    return this.toDto(
      updated,
      await this.names([updated.requestedById, userId]),
    );
  }

  async reject(
    userId: string,
    groupId: string,
    expenseId: string,
    reason: string,
  ) {
    const ctx = await this.access.leader(userId, groupId, 'reject expenses');
    const e = await this.loadPending(groupId, expenseId);
    if (e.requestedById === userId) {
      throw new ForbiddenException(
        'Cancel your own expense instead of rejecting it.',
      );
    }
    const updated = await this.prisma.expense.update({
      where: { id: e.id },
      data: {
        status: ExpenseStatus.REJECTED,
        rejectedById: userId,
        rejectionReason: reason.trim(),
      },
    });
    void this.notifications
      .notifyFinanceLeaders({
        groupId,
        type: NotificationType.EXPENSE_REJECTED,
        title: 'Expense rejected',
        body: `${decN(e.amount).toFixed(0)} RWF expense (“${e.description}”) was rejected in ${ctx.group.name}: ${reason.trim()}`,
        metadata: { groupName: ctx.group.name, expenseId: e.id },
        excludeUserId: userId,
      })
      .catch((err) => this.logger.error(err));
    return this.toDto(updated, await this.names([updated.requestedById]));
  }

  async cancel(userId: string, groupId: string, expenseId: string) {
    await this.access.leader(userId, groupId, 'cancel expenses');
    const e = await this.loadPending(groupId, expenseId);
    if (e.requestedById !== userId) {
      throw new ForbiddenException(
        'Only the leader who recorded this expense can cancel it.',
      );
    }
    const updated = await this.prisma.expense.update({
      where: { id: e.id },
      data: { status: ExpenseStatus.CANCELLED },
    });
    return this.toDto(updated, await this.names([userId]));
  }
}
