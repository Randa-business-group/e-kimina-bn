import { randomUUID } from 'node:crypto';
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
  FineStatus,
  FundType,
  LedgerDirection,
  LedgerEntryType,
  MemberLoanStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { GroupCashService } from '../finance-core/group-cash.service';
import { writeLedger } from '../finance-core/ledger';
import { EPS, dec, decN, roundMoney } from '../finance-core/money.util';
import { loanBalances } from '../finance-core/payment-allocation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountingAccessService } from './accounting-access.service';
import { CyclesService } from './cycles.service';

@Injectable()
export class AccountingService {
  private readonly logger = new Logger(AccountingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccountingAccessService,
    private readonly cash: GroupCashService,
    private readonly cycles: CyclesService,
    private readonly notifications: NotificationsService,
  ) {}

  private async currentCycle(groupId: string) {
    return this.prisma.groupCycle.findFirst({
      where: { groupId, status: { not: CycleStatus.CLOSED } },
      orderBy: { startDate: 'desc' },
    });
  }

  /**
   * Group balance dashboard. Members get the same totals (transparency) but no ledger lines.
   * `cycleId` limits flows (income, savings, expenses) to that cycle; balances are always now.
   */
  async summary(userId: string, groupId: string, cycleId?: string) {
    await this.access.member(userId, groupId);
    const pos = await this.cash.getCashPosition(groupId);
    const cycle = cycleId
      ? await this.prisma.groupCycle.findFirst({
          where: { id: cycleId, groupId },
        })
      : await this.currentCycle(groupId);
    if (cycleId && !cycle) throw new NotFoundException('Cycle not found.');

    const flows = await this.prisma.ledgerEntry.groupBy({
      by: ['type', 'direction', 'fund'],
      where: { groupId, ...(cycle ? { cycleId: cycle.id } : {}) },
      _sum: { amount: true },
    });
    const flow = (
      type: LedgerEntryType,
      dir: LedgerDirection,
      fund?: FundType,
    ) =>
      roundMoney(
        flows
          .filter(
            (f) =>
              f.type === type &&
              f.direction === dir &&
              (!fund || f.fund === fund),
          )
          .reduce((a, f) => a + decN(f._sum.amount), 0),
      );

    const [openLoans, lateRows, openFines, members] = await Promise.all([
      this.prisma.memberLoan.findMany({
        where: {
          groupId,
          status: { in: [MemberLoanStatus.ACTIVE, MemberLoanStatus.DEFAULTED] },
        },
      }),
      this.prisma.contribution.findMany({
        where: { groupId, status: ContributionStatus.LATE },
        select: { amount: true, amountPaid: true, fund: true },
      }),
      this.prisma.fine.findMany({
        where: { groupId, status: FineStatus.OPEN },
        select: { amount: true, amountPaid: true },
      }),
      this.prisma.userGroup.count({
        where: { groupId, membershipStatus: 'ACTIVE' },
      }),
    ]);
    const now = new Date();
    const loanOutstanding = roundMoney(
      openLoans.reduce((a, l) => a + loanBalances(l).outstanding, 0),
    );
    const interestIncome = flow(
      LedgerEntryType.LOAN_INTEREST,
      LedgerDirection.IN,
    );
    const penaltyIncome = flow(
      LedgerEntryType.LOAN_PENALTY,
      LedgerDirection.IN,
    );
    const fineIncome = flow(LedgerEntryType.FINE, LedgerDirection.IN);
    const expensesSavings = flow(
      LedgerEntryType.EXPENSE,
      LedgerDirection.OUT,
      FundType.SAVINGS,
    );
    const expensesSocial = flow(
      LedgerEntryType.EXPENSE,
      LedgerDirection.OUT,
      FundType.SOCIAL,
    );

    return {
      cycle: cycle
        ? {
            id: cycle.id,
            name: cycle.name,
            status: cycle.status,
            startDate: cycle.startDate.toISOString(),
            endDate: cycle.endDate.toISOString(),
          }
        : null,
      members,
      cash: pos,
      savings: {
        contributionsIn: flow(
          LedgerEntryType.CONTRIBUTION,
          LedgerDirection.IN,
          FundType.SAVINGS,
        ),
        openingBalances: flow(
          LedgerEntryType.OPENING_BALANCE,
          LedgerDirection.IN,
        ),
        sharedOut: flow(LedgerEntryType.SHARE_OUT, LedgerDirection.OUT),
        rotationPayouts: flow(
          LedgerEntryType.ROTATION_PAYOUT,
          LedgerDirection.OUT,
        ),
      },
      loans: {
        disbursed: flow(LedgerEntryType.LOAN_DISBURSEMENT, LedgerDirection.OUT),
        principalRepaid: flow(
          LedgerEntryType.LOAN_PRINCIPAL,
          LedgerDirection.IN,
        ),
        outstanding: loanOutstanding,
        openCount: openLoans.length,
        overdueCount: openLoans.filter((l) => l.dueDate < now).length,
        defaultedCount: openLoans.filter(
          (l) => l.status === MemberLoanStatus.DEFAULTED,
        ).length,
      },
      income: {
        interest: interestIncome,
        loanPenalties: penaltyIncome,
        fines: fineIncome,
        adjustments: roundMoney(
          flow(
            LedgerEntryType.ADJUSTMENT,
            LedgerDirection.IN,
            FundType.SAVINGS,
          ) -
            flow(
              LedgerEntryType.ADJUSTMENT,
              LedgerDirection.OUT,
              FundType.SAVINGS,
            ),
        ),
        expenses: expensesSavings,
        netProfit: roundMoney(
          interestIncome + penaltyIncome + fineIncome - expensesSavings,
        ),
      },
      socialFund: {
        contributionsIn: flow(
          LedgerEntryType.CONTRIBUTION,
          LedgerDirection.IN,
          FundType.SOCIAL,
        ),
        payouts: flow(LedgerEntryType.SOCIAL_PAYOUT, LedgerDirection.OUT),
        expenses: expensesSocial,
        balance: pos.socialBalance,
      },
      arrears: {
        lateContributions: lateRows.length,
        lateAmount: roundMoney(
          lateRows.reduce((a, r) => a + decN(r.amount) - decN(r.amountPaid), 0),
        ),
        openFines: roundMoney(
          openFines.reduce(
            (a, f) => a + decN(f.amount) - decN(f.amountPaid),
            0,
          ),
        ),
      },
    };
  }

  /** Paged cash book (leaders and super admins). */
  async ledger(
    userId: string,
    groupId: string,
    q: {
      cycleId?: string;
      fund?: FundType;
      type?: LedgerEntryType;
      userId?: string;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    await this.access.reader(userId, groupId);
    await this.cash.ensureLedger(groupId);
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const where: Prisma.LedgerEntryWhereInput = {
      groupId,
      ...(q.cycleId ? { cycleId: q.cycleId } : {}),
      ...(q.fund ? { fund: q.fund } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.from || q.to
        ? {
            occurredAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };
    const [total, rows, sums] = await Promise.all([
      this.prisma.ledgerEntry.count({ where }),
      this.prisma.ledgerEntry.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.ledgerEntry.groupBy({
        by: ['direction'],
        where,
        _sum: { amount: true },
      }),
    ]);
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: rows.map((r) => r.userId).filter((x): x is string => !!x) },
      },
      select: { id: true, fullName: true },
    });
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    const totalIn = decN(
      sums.find((s) => s.direction === LedgerDirection.IN)?._sum.amount,
    );
    const totalOut = decN(
      sums.find((s) => s.direction === LedgerDirection.OUT)?._sum.amount,
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        fund: r.fund,
        type: r.type,
        direction: r.direction,
        amount: decN(r.amount),
        userId: r.userId,
        userName: r.userId ? (name.get(r.userId) ?? null) : null,
        description: r.description,
        cycleId: r.cycleId,
        depositId: r.depositId,
        memberLoanId: r.memberLoanId,
        expenseId: r.expenseId,
      })),
      totals: {
        in: roundMoney(totalIn),
        out: roundMoney(totalOut),
        net: roundMoney(totalIn - totalOut),
      },
      page,
      pageSize,
      totalItems: total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /** Member balance: own (any member) or any member's (leaders). */
  async statement(actorId: string, groupId: string, memberUserId: string) {
    const ctx = await this.access.member(actorId, groupId);
    if (memberUserId !== actorId && !ctx.isLeader && !ctx.isSuperAdmin) {
      throw new ForbiddenException('You can only view your own statement.');
    }
    const membership = await this.prisma.userGroup.findUnique({
      where: { userId_groupId: { userId: memberUserId, groupId } },
      include: { user: { select: { fullName: true } } },
    });
    if (!membership)
      throw new NotFoundException('This user is not in the group.');
    const cycle = await this.currentCycle(groupId);

    const [byType, loans, fines, recent] = await Promise.all([
      this.prisma.ledgerEntry.groupBy({
        by: ['type', 'direction', 'fund', 'cycleId'],
        where: { groupId, userId: memberUserId },
        _sum: { amount: true },
      }),
      this.prisma.memberLoan.findMany({
        where: {
          groupId,
          userId: memberUserId,
          status: {
            in: [
              MemberLoanStatus.ACTIVE,
              MemberLoanStatus.DEFAULTED,
              MemberLoanStatus.WRITTEN_OFF,
            ],
          },
        },
      }),
      this.prisma.fine.findMany({
        where: { groupId, userId: memberUserId, status: FineStatus.OPEN },
        select: { amount: true, amountPaid: true },
      }),
      this.prisma.ledgerEntry.findMany({
        where: { groupId, userId: memberUserId },
        orderBy: { occurredAt: 'desc' },
        take: 20,
      }),
    ]);
    const sum = (pred: (r: (typeof byType)[number]) => boolean) =>
      roundMoney(
        byType.filter(pred).reduce((a, r) => a + decN(r._sum.amount), 0),
      );
    const inCycle = (r: (typeof byType)[number]) =>
      !cycle || r.cycleId === cycle.id;

    let projected: {
      profitShare: number;
      grossAmount: number;
      netPayout: number;
      sharePercent: number;
    } | null = null;
    if (cycle) {
      const so = await this.cycles.shareOut(actorId, groupId, cycle.id);
      const line = (
        so.lines as {
          userId: string;
          profitShare: number;
          grossAmount: number;
          netPayout: number;
          sharePercent?: number;
        }[]
      ).find((l) => l.userId === memberUserId);
      if (line) {
        projected = {
          profitShare: line.profitShare,
          grossAmount: line.grossAmount,
          netPayout: line.netPayout,
          sharePercent: line.sharePercent ?? 0,
        };
      }
    }

    return {
      userId: memberUserId,
      fullName: membership.user.fullName,
      cycle: cycle ? { id: cycle.id, name: cycle.name } : null,
      savings: {
        thisCycle: sum(
          (r) =>
            inCycle(r) &&
            r.type === LedgerEntryType.CONTRIBUTION &&
            r.fund === FundType.SAVINGS &&
            r.direction === LedgerDirection.IN,
        ),
        openingBalance: sum(
          (r) => inCycle(r) && r.type === LedgerEntryType.OPENING_BALANCE,
        ),
        allTime: sum(
          (r) =>
            r.type === LedgerEntryType.CONTRIBUTION &&
            r.fund === FundType.SAVINGS &&
            r.direction === LedgerDirection.IN,
        ),
        receivedFromShareOuts: sum(
          (r) =>
            r.type === LedgerEntryType.SHARE_OUT &&
            r.direction === LedgerDirection.OUT,
        ),
      },
      socialFund: {
        contributed: sum(
          (r) =>
            r.type === LedgerEntryType.CONTRIBUTION &&
            r.fund === FundType.SOCIAL,
        ),
        received: sum((r) => r.type === LedgerEntryType.SOCIAL_PAYOUT),
      },
      finesPaid: sum(
        (r) =>
          r.type === LedgerEntryType.FINE && r.direction === LedgerDirection.IN,
      ),
      openFines: roundMoney(
        fines.reduce((a, f) => a + decN(f.amount) - decN(f.amountPaid), 0),
      ),
      loans: loans.map((l) => ({
        id: l.id,
        status: l.status,
        dueDate: l.dueDate.toISOString(),
        ...loanBalances(l),
      })),
      loanOutstanding: roundMoney(
        loans.reduce((a, l) => a + loanBalances(l).outstanding, 0),
      ),
      projectedShareOut: projected,
      recent: recent.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        fund: r.fund,
        type: r.type,
        direction: r.direction,
        amount: decN(r.amount),
        description: r.description,
      })),
    };
  }

  /**
   * Manual correction or opening balance (e.g. cash held before the group used the app).
   * OPENING_BALANCE needs a member and an open cycle; it counts as that member's savings.
   */
  async adjust(
    actorId: string,
    groupId: string,
    dto: {
      type: 'ADJUSTMENT' | 'OPENING_BALANCE';
      fund: FundType;
      direction: LedgerDirection;
      amount: number;
      reason: string;
      userId?: string;
      occurredAt?: string;
    },
  ) {
    const ctx = await this.access.leader(
      actorId,
      groupId,
      'record ledger adjustments',
    );
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime()))
      throw new BadRequestException('Invalid date.');
    if (dto.type === 'OPENING_BALANCE') {
      if (
        !dto.userId ||
        dto.direction !== LedgerDirection.IN ||
        dto.fund !== FundType.SAVINGS
      ) {
        throw new BadRequestException(
          'An opening balance is money IN to the savings fund for one member.',
        );
      }
      if (!(await this.currentCycle(groupId))) {
        throw new BadRequestException(
          'Start a cycle before recording opening balances.',
        );
      }
    }
    if (dto.userId) {
      const m = await this.prisma.userGroup.findFirst({
        where: { groupId, userId: dto.userId },
      });
      if (!m) throw new NotFoundException('This user is not in the group.');
    }
    if (dto.direction === LedgerDirection.OUT) {
      const pos = await this.cash.getCashPosition(groupId);
      const avail =
        dto.fund === FundType.SOCIAL ? pos.socialAvailable : pos.available;
      if (dto.amount - avail > EPS) {
        throw new BadRequestException(
          `Only ${avail.toFixed(0)} RWF is available in that fund.`,
        );
      }
    }
    const id = randomUUID();
    await writeLedger(this.prisma, [
      {
        groupId,
        type:
          dto.type === 'OPENING_BALANCE'
            ? LedgerEntryType.OPENING_BALANCE
            : LedgerEntryType.ADJUSTMENT,
        fund: dto.fund,
        direction: dto.direction,
        amount: roundMoney(dto.amount),
        userId: dto.userId ?? null,
        description: dto.reason.trim(),
        createdById: actorId,
        occurredAt,
        sourceKey: `adj:${id}`,
      },
    ]);
    void this.notifications
      .notifyFinanceLeaders({
        groupId,
        type: NotificationType.LEDGER_ADJUSTMENT,
        title: 'Ledger adjustment recorded',
        body: `${dto.direction === LedgerDirection.IN ? '+' : '−'}${dto.amount.toFixed(0)} RWF (${dto.fund.toLowerCase()}, ${dto.type.toLowerCase().replace('_', ' ')}) in ${ctx.group.name}: ${dto.reason.trim()}`,
        metadata: { groupName: ctx.group.name, sourceKey: `adj:${id}` },
        excludeUserId: actorId,
      })
      .catch((e) => this.logger.error(e));
    const entry = await this.prisma.ledgerEntry.findUnique({
      where: { sourceKey: `adj:${id}` },
    });
    return {
      id: entry?.id,
      sourceKey: `adj:${id}`,
      cycleId: entry?.cycleId ?? null,
    };
  }

  /** msfts §2.6: per-member savings amount (null = group default). Future untouched periods follow. */
  async setContributionAmount(
    actorId: string,
    groupId: string,
    memberUserId: string,
    amount: number | null,
  ) {
    await this.access.admin(
      actorId,
      groupId,
      'set member contribution amounts',
    );
    const m = await this.prisma.userGroup.findUnique({
      where: { userId_groupId: { userId: memberUserId, groupId } },
    });
    if (!m) throw new NotFoundException('This user is not in the group.');
    const cfg = await this.prisma.contributionConfig.findUnique({
      where: { groupId },
    });
    if (!cfg)
      throw new BadRequestException('Set the contribution rules first.');
    if (amount != null && amount <= 0)
      throw new BadRequestException('Amount must be positive.');
    await this.prisma.userGroup.update({
      where: { id: m.id },
      data: { customContributionAmount: amount != null ? dec(amount) : null },
    });
    const effective = amount != null ? dec(amount) : cfg.amount;
    const res = await this.prisma.contribution.updateMany({
      where: {
        groupId,
        userId: memberUserId,
        fund: FundType.SAVINGS,
        status: ContributionStatus.PENDING,
        amountPaid: 0,
        dueDate: { gt: new Date() },
      },
      data: { amount: effective },
    });
    return {
      userId: memberUserId,
      customContributionAmount: amount,
      effectiveAmount: decN(effective),
      futurePeriodsUpdated: res.count,
    };
  }
}
