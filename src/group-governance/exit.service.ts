import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ContributionStatus,
  CycleStatus,
  ExitKind,
  ExitRequest,
  ExitRequestStatus,
  FineStatus,
  FundType,
  GroupMembershipStatus,
  LedgerDirection,
  LedgerEntryType,
  LoanApplicationStatus,
  MemberLoanStatus,
  NotificationType,
  Prisma,
  RoleName,
} from '@prisma/client';
import { GroupCashService } from '../finance-core/group-cash.service';
import {
  LedgerInput,
  splitLoanRepayment,
  writeLedger,
} from '../finance-core/ledger';
import { EPS, dec, decN, roundMoney } from '../finance-core/money.util';
import { afterLoanPayment } from '../finance-core/loan-installments';
import { loanBalances } from '../finance-core/payment-allocation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { GovernanceAccessService } from './governance-access.service';

type Db = Prisma.TransactionClient;

export interface ExitFigures {
  savingsBase: number;
  fineDebt: number;
  loanDebt: number;
  fineDeduction: number;
  loanDeduction: number;
  uncoveredDebt: number;
  refundAmount: number;
  cycleId: string | null;
}

/**
 * Leaving the group (msfts §3): the member gets back their savings (current cycle, or all
 * unpaid savings when the group runs no cycles) minus open fines and loans. Profit is only
 * distributed at the cycle share-out, so a member who leaves early does not take a share.
 */
@Injectable()
export class ExitService {
  private readonly logger = new Logger(ExitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GovernanceAccessService,
    private readonly cash: GroupCashService,
    private readonly notifications: NotificationsService,
  ) {}

  async figures(
    groupId: string,
    userId: string,
    db: Db = this.prisma,
  ): Promise<ExitFigures> {
    await this.cash.ensureLedger(groupId, db);
    const open = await db.groupCycle.findFirst({
      where: { groupId, status: { not: CycleStatus.CLOSED } },
      orderBy: { startDate: 'desc' },
    });
    if (open?.status === CycleStatus.CLOSING) {
      throw new BadRequestException(
        'The share-out is being prepared; settle exits after the cycle closes.',
      );
    }
    const sums = await db.ledgerEntry.groupBy({
      by: ['type', 'direction'],
      where: {
        groupId,
        userId,
        fund: FundType.SAVINGS,
        ...(open ? { cycleId: open.id } : {}),
      },
      _sum: { amount: true },
    });
    const s = (type: LedgerEntryType, dir: LedgerDirection) =>
      decN(
        sums.find((x) => x.type === type && x.direction === dir)?._sum.amount,
      );
    const paidIn =
      s(LedgerEntryType.CONTRIBUTION, LedgerDirection.IN) +
      s(LedgerEntryType.OPENING_BALANCE, LedgerDirection.IN);
    const paidOut =
      s(LedgerEntryType.EXIT_REFUND, LedgerDirection.OUT) +
      (open ? 0 : s(LedgerEntryType.SHARE_OUT, LedgerDirection.OUT));
    const savingsBase = roundMoney(Math.max(0, paidIn - paidOut));

    const [fines, loans] = await Promise.all([
      db.fine.findMany({ where: { groupId, userId, status: FineStatus.OPEN } }),
      db.memberLoan.findMany({
        where: {
          groupId,
          userId,
          status: { in: [MemberLoanStatus.ACTIVE, MemberLoanStatus.DEFAULTED] },
        },
      }),
    ]);
    const fineDebt = roundMoney(
      fines.reduce((a, f) => a + decN(f.amount) - decN(f.amountPaid), 0),
    );
    const loanDebt = roundMoney(
      loans.reduce((a, l) => a + loanBalances(l).outstanding, 0),
    );
    let left = savingsBase;
    const fineDeduction = roundMoney(Math.min(left, fineDebt));
    left = roundMoney(left - fineDeduction);
    const loanDeduction = roundMoney(Math.min(left, loanDebt));
    left = roundMoney(left - loanDeduction);
    return {
      savingsBase,
      fineDebt,
      loanDebt,
      fineDeduction,
      loanDeduction,
      uncoveredDebt: roundMoney(
        fineDebt + loanDebt - fineDeduction - loanDeduction,
      ),
      refundAmount: left,
      cycleId: open?.id ?? null,
    };
  }

  private async names(ids: string[]) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  private dto(
    r: ExitRequest,
    name: Map<string, string>,
    live?: ExitFigures | null,
  ) {
    return {
      id: r.id,
      userId: r.userId,
      fullName: name.get(r.userId) ?? null,
      kind: r.kind,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      settledAt: r.settledAt?.toISOString() ?? null,
      method: r.method,
      reference: r.reference,
      rejectionReason: r.rejectionReason,
      figures:
        r.status === ExitRequestStatus.SETTLED
          ? {
              savingsBase: decN(r.savingsBase),
              fineDeduction: decN(r.fineDeduction),
              loanDeduction: decN(r.loanDeduction),
              uncoveredDebt: decN(r.uncoveredDebt),
              refundAmount: decN(r.refundAmount),
            }
          : (live ?? null),
    };
  }

  async preview(actorId: string, groupId: string) {
    await this.access.context(actorId, groupId);
    return this.figures(groupId, actorId);
  }

  async request(actorId: string, groupId: string, reason: string) {
    const ctx = await this.access.context(actorId, groupId);
    if (ctx.role === RoleName.GROUP_ADMIN) {
      const admins = await this.prisma.userGroup.count({
        where: {
          groupId,
          membershipStatus: GroupMembershipStatus.ACTIVE,
          role: { name: RoleName.GROUP_ADMIN },
        },
      });
      if (admins <= 1) {
        throw new BadRequestException(
          'You are the only group admin. Transfer the admin role before leaving.',
        );
      }
    }
    const pending = await this.prisma.exitRequest.findFirst({
      where: { groupId, userId: actorId, status: ExitRequestStatus.PENDING },
    });
    if (pending)
      throw new BadRequestException('You already asked to leave this group.');
    const fig = await this.figures(groupId, actorId);
    const r = await this.prisma.exitRequest.create({
      data: {
        groupId,
        userId: actorId,
        kind: ExitKind.VOLUNTARY,
        reason: reason.trim(),
        requestedById: actorId,
      },
    });
    const name = await this.names([actorId]);
    void this.notifications
      .notifyFinanceLeaders({
        groupId,
        type: NotificationType.EXIT_REQUESTED,
        title: 'Member wants to leave',
        body: `${name.get(actorId)} asked to leave ${ctx.group.name}. Estimated refund: ${fig.refundAmount.toFixed(0)} RWF${fig.uncoveredDebt > EPS ? ` (debts of ${fig.uncoveredDebt.toFixed(0)} RWF are not covered)` : ''}.`,
        metadata: { groupName: ctx.group.name, exitRequestId: r.id },
        excludeUserId: actorId,
      })
      .catch((e) => this.logger.error(e));
    return this.dto(r, name, fig);
  }

  async list(actorId: string, groupId: string, status?: ExitRequestStatus) {
    const ctx = await this.access.member(actorId, groupId);
    const rows = await this.prisma.exitRequest.findMany({
      where: {
        groupId,
        ...(status ? { status } : {}),
        ...(ctx.isLeader || ctx.isSuperAdmin ? {} : { userId: actorId }),
      },
      orderBy: { createdAt: 'desc' },
    });
    const name = await this.names(rows.map((r) => r.userId));
    return Promise.all(
      rows.map(async (r) => {
        const live =
          r.status === ExitRequestStatus.PENDING
            ? await this.figures(groupId, r.userId).catch(() => null)
            : null;
        return this.dto(r, name, live);
      }),
    );
  }

  private async load(groupId: string, id: string) {
    const r = await this.prisma.exitRequest.findFirst({
      where: { id, groupId },
    });
    if (!r) throw new NotFoundException('Exit request not found.');
    if (r.status !== ExitRequestStatus.PENDING)
      throw new BadRequestException('This exit is no longer pending.');
    return r;
  }

  async cancel(actorId: string, groupId: string, id: string) {
    await this.access.context(actorId, groupId);
    const r = await this.load(groupId, id);
    if (r.kind !== ExitKind.VOLUNTARY || r.userId !== actorId) {
      throw new ForbiddenException(
        'Only the member who asked to leave can cancel.',
      );
    }
    const u = await this.prisma.exitRequest.update({
      where: { id },
      data: { status: ExitRequestStatus.CANCELLED },
    });
    return this.dto(u, await this.names([r.userId]));
  }

  async reject(actorId: string, groupId: string, id: string, reason: string) {
    const ctx = await this.access.leader(actorId, groupId, 'decide on exits');
    const r = await this.load(groupId, id);
    if (r.kind !== ExitKind.VOLUNTARY)
      throw new BadRequestException(
        'A removal cannot be rejected; settle it instead.',
      );
    if (r.userId === actorId)
      throw new ForbiddenException('Another leader must decide on your exit.');
    const u = await this.prisma.exitRequest.update({
      where: { id },
      data: {
        status: ExitRequestStatus.REJECTED,
        decidedById: actorId,
        rejectionReason: reason.trim(),
      },
    });
    void this.notifications
      .notifyMember({
        userId: r.userId,
        groupId,
        type: NotificationType.EXIT_REJECTED,
        title: 'Exit request not approved',
        body: `Your request to leave ${ctx.group.name} was not approved: ${reason.trim()}`,
        metadata: { groupName: ctx.group.name, exitRequestId: id },
      })
      .catch((e) => this.logger.error(e));
    return this.dto(u, await this.names([r.userId]));
  }

  /** Leader settles: debts offset against savings, refund paid, membership EXITED. */
  async settle(
    actorId: string,
    groupId: string,
    id: string,
    dto: { method: string; reference?: string },
  ) {
    const ctx = await this.access.leader(actorId, groupId, 'settle exits');
    const r = await this.load(groupId, id);
    if (r.userId === actorId)
      throw new ForbiddenException('Another leader must settle your exit.');
    const now = new Date();

    const fig = await this.prisma.$transaction(
      async (tx) => {
        const f = await this.figures(groupId, r.userId, tx);
        if (r.kind === ExitKind.VOLUNTARY && f.uncoveredDebt > EPS) {
          throw new BadRequestException(
            `The member's debts exceed their savings by ${f.uncoveredDebt.toFixed(0)} RWF. They must repay before leaving.`,
          );
        }
        const pos = await this.cash.getCashPosition(groupId, tx);
        if (f.refundAmount - pos.available > EPS) {
          throw new BadRequestException(
            `The group only has ${pos.available.toFixed(0)} RWF available for the refund.`,
          );
        }
        const claimed = await tx.exitRequest.updateMany({
          where: { id, status: ExitRequestStatus.PENDING },
          data: {
            status: ExitRequestStatus.SETTLED,
            savingsBase: dec(f.savingsBase),
            fineDeduction: dec(f.fineDeduction),
            loanDeduction: dec(f.loanDeduction),
            uncoveredDebt: dec(f.uncoveredDebt),
            refundAmount: dec(f.refundAmount),
            method: dto.method,
            reference: dto.reference?.trim() || null,
            settledById: actorId,
            settledAt: now,
            decidedById: actorId,
          },
        });
        if (claimed.count === 0)
          throw new BadRequestException('This exit is no longer pending.');
        await this.offsetDebts(tx, groupId, r.userId, id, f, now, actorId);
        await writeLedger(tx, [
          {
            groupId,
            cycleId: f.cycleId,
            userId: r.userId,
            type: LedgerEntryType.EXIT_REFUND,
            direction: LedgerDirection.OUT,
            amount: f.refundAmount,
            createdById: actorId,
            occurredAt: now,
            description: `Exit refund (${dto.method})`,
            sourceKey: `exit:${id}:refund`,
          },
        ]);
        await tx.userGroup.updateMany({
          where: { groupId, userId: r.userId },
          data: {
            membershipStatus: GroupMembershipStatus.EXITED,
            exitedAt: now,
          },
        });
        await tx.contribution.updateMany({
          where: {
            groupId,
            userId: r.userId,
            status: {
              in: [
                ContributionStatus.PENDING,
                ContributionStatus.PARTIALLY_PAID,
                ContributionStatus.LATE,
              ],
            },
          },
          data: { status: ContributionStatus.CANCELLED },
        });
        await tx.loanApplication.updateMany({
          where: {
            groupId,
            userId: r.userId,
            status: LoanApplicationStatus.PENDING,
          },
          data: { status: LoanApplicationStatus.CANCELLED },
        });
        return f;
      },
      { timeout: 30_000 },
    );

    void this.notifications
      .notifyMember({
        userId: r.userId,
        groupId,
        type: NotificationType.EXIT_SETTLED,
        title: 'You left the group',
        body: `Your exit from ${ctx.group.name} is settled: savings ${fig.savingsBase.toFixed(0)} RWF − debts ${(fig.fineDeduction + fig.loanDeduction).toFixed(0)} RWF → ${fig.refundAmount.toFixed(0)} RWF refunded (${dto.method}).`,
        metadata: { groupName: ctx.group.name, exitRequestId: id },
      })
      .catch((e) => this.logger.error(e));
    const u = await this.prisma.exitRequest.findUniqueOrThrow({
      where: { id },
    });
    return this.dto(u, await this.names([r.userId]));
  }

  private async offsetDebts(
    tx: Db,
    groupId: string,
    userId: string,
    exitId: string,
    f: ExitFigures,
    now: Date,
    actorId: string,
  ) {
    const entries: LedgerInput[] = [];
    const pair = (
      key: string,
      type: LedgerEntryType,
      amount: number,
      refs: Partial<LedgerInput>,
    ) => {
      if (amount < EPS) return;
      const base = {
        groupId,
        cycleId: f.cycleId,
        userId,
        occurredAt: now,
        createdById: actorId,
        ...refs,
      };
      entries.push({
        ...base,
        type,
        direction: LedgerDirection.IN,
        amount,
        sourceKey: `exit:${exitId}:${key}`,
        description: 'Settled from exit refund',
      });
      entries.push({
        ...base,
        type: LedgerEntryType.EXIT_REFUND,
        direction: LedgerDirection.OUT,
        amount,
        sourceKey: `exit:${exitId}:${key}:offset`,
        description: 'Debt deducted from savings on exit',
      });
    };
    let fineLeft = f.fineDeduction;
    for (const fine of await tx.fine.findMany({
      where: { groupId, userId, status: FineStatus.OPEN },
      orderBy: { createdAt: 'asc' },
    })) {
      if (fineLeft < EPS) break;
      const due = roundMoney(decN(fine.amount) - decN(fine.amountPaid));
      const pay = roundMoney(Math.min(due, fineLeft));
      await tx.fine.update({
        where: { id: fine.id },
        data: {
          amountPaid: dec(decN(fine.amountPaid) + pay),
          ...(pay >= due - EPS ? { status: FineStatus.PAID, paidAt: now } : {}),
        },
      });
      pair(`fine:${fine.id}`, LedgerEntryType.FINE, pay, { fineId: fine.id });
      fineLeft = roundMoney(fineLeft - pay);
    }
    let loanLeft = f.loanDeduction;
    for (const loan of await tx.memberLoan.findMany({
      where: {
        groupId,
        userId,
        status: { in: [MemberLoanStatus.ACTIVE, MemberLoanStatus.DEFAULTED] },
      },
      orderBy: { createdAt: 'asc' },
    })) {
      if (loanLeft < EPS) break;
      const { penalty, balance } = loanBalances(loan);
      const toPen = roundMoney(Math.min(loanLeft, penalty));
      loanLeft = roundMoney(loanLeft - toPen);
      const toBal = roundMoney(Math.min(loanLeft, balance));
      loanLeft = roundMoney(loanLeft - toBal);
      const newRepaid = roundMoney(decN(loan.amountRepaid) + toBal);
      const newPen = roundMoney(penalty - toPen);
      const cleared =
        newPen + Math.max(0, decN(loan.totalRepayable) - newRepaid) < EPS;
      await tx.memberLoan.update({
        where: { id: loan.id },
        data: {
          amountRepaid: dec(newRepaid),
          penaltyAccrued: dec(newPen),
          ...(cleared ? { status: MemberLoanStatus.REPAID } : {}),
        },
      });
      await afterLoanPayment(tx, loan.id, toBal, cleared, now);
      pair(`loan:${loan.id}:penalty`, LedgerEntryType.LOAN_PENALTY, toPen, {
        memberLoanId: loan.id,
      });
      const split = splitLoanRepayment(loan, toBal);
      pair(
        `loan:${loan.id}:principal`,
        LedgerEntryType.LOAN_PRINCIPAL,
        split.principal,
        { memberLoanId: loan.id },
      );
      pair(
        `loan:${loan.id}:interest`,
        LedgerEntryType.LOAN_INTEREST,
        split.interest,
        { memberLoanId: loan.id },
      );
    }
    await writeLedger(tx, entries);
  }
}
