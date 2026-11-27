import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ContributionStatus,
  CycleStatus,
  DepositRecordStatus,
  FineStatus,
  FundType,
  GroupMembershipStatus,
  GuarantorStatus,
  LedgerDirection,
  LedgerEntryType,
  LoanDisbursementStatus,
  MemberLoanStatus,
  Prisma,
} from '@prisma/client';
import { AccountingAccessService } from '../group-accounting/accounting-access.service';
import { CyclesService } from '../group-accounting/cycles.service';
import { GroupCashService } from '../finance-core/group-cash.service';
import { DAY_MS, EPS, decN, roundMoney } from '../finance-core/money.util';
import { loanBalances } from '../finance-core/payment-allocation.service';
import { PrismaService } from '../prisma/prisma.service';

export interface Range {
  from: Date;
  to: Date;
}

const TYPE_LABEL: Record<LedgerEntryType, string> = {
  CONTRIBUTION: 'Contribution',
  FINE: 'Fine',
  LOAN_DISBURSEMENT: 'Loan payout',
  LOAN_PRINCIPAL: 'Loan repayment (principal)',
  LOAN_INTEREST: 'Loan repayment (interest)',
  LOAN_PENALTY: 'Loan penalty',
  EXPENSE: 'Expense',
  SOCIAL_PAYOUT: 'Social fund payout',
  SHARE_OUT: 'Share-out',
  ROTATION_PAYOUT: 'Rotation payout',
  OPENING_BALANCE: 'Opening balance',
  ADJUSTMENT: 'Adjustment',
  EXIT_REFUND: 'Exit refund',
};

const monthKey = (d: Date) => d.toISOString().slice(0, 7);

/** Group reports (msfts §5). Every method returns plain data; rendering lives elsewhere. */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccountingAccessService,
    private readonly cycles: CyclesService,
    private readonly cash: GroupCashService,
  ) {}

  /** Default range: the open cycle, else the last 12 months. `to` is inclusive (end of day). */
  async range(groupId: string, from?: string, to?: string): Promise<Range> {
    const parse = (s: string, end: boolean) => {
      const d = new Date(s);
      if (Number.isNaN(d.getTime()))
        throw new BadRequestException(`Invalid date: ${s}`);
      return s.length <= 10 && end ? new Date(d.getTime() + DAY_MS - 1) : d;
    };
    let f = from ? parse(from, false) : null;
    const t = to ? parse(to, true) : new Date();
    if (!f) {
      const c = await this.prisma.groupCycle.findFirst({
        where: { groupId, status: { not: CycleStatus.CLOSED } },
        orderBy: { startDate: 'desc' },
      });
      f = c?.startDate ?? new Date(t.getTime() - 365 * DAY_MS);
    }
    if (f > t) throw new BadRequestException('"from" must be before "to".');
    return { from: f, to: t };
  }

  private async groupName(groupId: string) {
    return (
      await this.prisma.group.findUniqueOrThrow({
        where: { id: groupId },
        select: { name: true },
      })
    ).name;
  }

  // ── member statement ────────────────────────────────────────────────────

  async memberStatement(
    actorId: string,
    groupId: string,
    userId: string,
    r: Range,
  ) {
    const ctx = await this.access.member(actorId, groupId);
    if (userId !== actorId && !ctx.isLeader && !ctx.isSuperAdmin) {
      throw new ForbiddenException('You can only download your own statement.');
    }
    const m = await this.prisma.userGroup.findUnique({
      where: { userId_groupId: { userId, groupId } },
      include: {
        user: { select: { fullName: true, email: true, phoneNumber: true } },
      },
    });
    if (!m) throw new NotFoundException('This user is not in the group.');
    await this.cash.ensureLedger(groupId);

    const savingsBefore = await this.prisma.ledgerEntry.aggregate({
      where: {
        groupId,
        userId,
        fund: FundType.SAVINGS,
        type: LedgerEntryType.CONTRIBUTION,
        direction: LedgerDirection.IN,
        occurredAt: { lt: r.from },
      },
      _sum: { amount: true },
    });
    const [entries, contributions, loans, fines] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where: { groupId, userId, occurredAt: { gte: r.from, lte: r.to } },
        orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.contribution.findMany({
        where: { groupId, userId, dueDate: { gte: r.from, lte: r.to } },
        orderBy: { dueDate: 'asc' },
      }),
      this.prisma.memberLoan.findMany({
        where: { groupId, userId },
        orderBy: { disbursedAt: 'asc' },
      }),
      this.prisma.fine.findMany({
        where: { groupId, userId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const sumIf = (pred: (e: (typeof entries)[number]) => boolean) =>
      roundMoney(entries.filter(pred).reduce((a, e) => a + decN(e.amount), 0));
    const savingsInPeriod = sumIf(
      (e) =>
        e.type === LedgerEntryType.CONTRIBUTION &&
        e.fund === FundType.SAVINGS &&
        e.direction === LedgerDirection.IN,
    );
    const openingSavings = roundMoney(decN(savingsBefore._sum.amount));
    const openLoans = loans.filter(
      (l) =>
        l.status === MemberLoanStatus.ACTIVE ||
        l.status === MemberLoanStatus.DEFAULTED,
    );
    return {
      group: await this.groupName(groupId),
      member: {
        userId,
        name: m.user.fullName,
        email: m.user.email,
        phone: m.user.phoneNumber,
        status: m.membershipStatus,
      },
      period: { from: r.from.toISOString(), to: r.to.toISOString() },
      summary: {
        openingSavings,
        savingsInPeriod,
        closingSavings: roundMoney(openingSavings + savingsInPeriod),
        socialFundInPeriod: sumIf(
          (e) =>
            e.type === LedgerEntryType.CONTRIBUTION &&
            e.fund === FundType.SOCIAL,
        ),
        finesPaidInPeriod: sumIf(
          (e) =>
            e.type === LedgerEntryType.FINE &&
            e.direction === LedgerDirection.IN,
        ),
        loanRepaidInPeriod: sumIf(
          (e) =>
            e.direction === LedgerDirection.IN &&
            (e.type === LedgerEntryType.LOAN_PRINCIPAL ||
              e.type === LedgerEntryType.LOAN_INTEREST ||
              e.type === LedgerEntryType.LOAN_PENALTY),
        ),
        openFines: roundMoney(
          fines
            .filter((f) => f.status === FineStatus.OPEN)
            .reduce((a, f) => a + decN(f.amount) - decN(f.amountPaid), 0),
        ),
        loanOutstanding: roundMoney(
          openLoans.reduce((a, l) => a + loanBalances(l).outstanding, 0),
        ),
        lateContributions: contributions.filter(
          (c) => c.status === ContributionStatus.LATE,
        ).length,
      },
      lines: entries.map((e) => ({
        date: e.occurredAt.toISOString(),
        type: e.type,
        label: TYPE_LABEL[e.type],
        fund: e.fund,
        direction: e.direction,
        amount: decN(e.amount),
        description: e.description,
      })),
      contributions: contributions.map((c) => ({
        dueDate: c.dueDate.toISOString(),
        fund: c.fund,
        amount: decN(c.amount),
        amountPaid: decN(c.amountPaid),
        status: c.status,
      })),
      loans: loans.map((l) => ({
        id: l.id,
        disbursedAt: l.disbursedAt.toISOString(),
        dueDate: l.dueDate.toISOString(),
        principal: decN(l.principalAmount),
        totalRepayable: decN(l.totalRepayable),
        repaid: decN(l.amountRepaid),
        outstanding: loanBalances(l).outstanding,
        status: l.status,
      })),
      fines: fines
        .filter((f) => f.createdAt >= r.from && f.createdAt <= r.to)
        .map((f) => ({
          date: f.createdAt.toISOString(),
          type: f.type,
          reason: f.reason,
          amount: decN(f.amount),
          status: f.status,
        })),
    };
  }

  // ── contribution matrix ─────────────────────────────────────────────────

  async contributionMatrix(
    actorId: string,
    groupId: string,
    r: Range,
    fund: FundType = FundType.SAVINGS,
  ) {
    await this.access.reader(actorId, groupId);
    const rows = await this.prisma.contribution.findMany({
      where: { groupId, fund, dueDate: { gte: r.from, lte: r.to } },
      select: {
        userId: true,
        dueDate: true,
        status: true,
        amount: true,
        amountPaid: true,
      },
      orderBy: { dueDate: 'asc' },
    });
    const periods = [
      ...new Set(rows.map((x) => x.dueDate.toISOString())),
    ].sort();
    const members = await this.prisma.userGroup.findMany({
      where: {
        groupId,
        OR: [
          { membershipStatus: GroupMembershipStatus.ACTIVE },
          { userId: { in: [...new Set(rows.map((x) => x.userId))] } },
        ],
      },
      include: { user: { select: { fullName: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    const byKey = new Map(
      rows.map((x) => [`${x.userId}|${x.dueDate.toISOString()}`, x]),
    );
    const memberRows = members.map((m) => {
      const cells = periods.map((p) => {
        const c = byKey.get(`${m.userId}|${p}`);
        return c
          ? {
              status: c.status,
              amount: decN(c.amount),
              amountPaid: decN(c.amountPaid),
            }
          : null;
      });
      const count = (s: ContributionStatus) =>
        cells.filter((c) => c?.status === s).length;
      return {
        userId: m.userId,
        name: m.user.fullName,
        membershipStatus: m.membershipStatus,
        cells,
        paid: count(ContributionStatus.PAID),
        late: count(ContributionStatus.LATE),
        partial: count(ContributionStatus.PARTIALLY_PAID),
        pending: count(ContributionStatus.PENDING),
        amountPaid: roundMoney(
          cells.reduce((a, c) => a + (c?.amountPaid ?? 0), 0),
        ),
        amountDue: roundMoney(
          cells.reduce(
            (a, c) =>
              a +
              (c && c.status !== ContributionStatus.CANCELLED ? c.amount : 0),
            0,
          ),
        ),
      };
    });
    const periodTotals = periods.map((p, i) => {
      const cells = memberRows
        .map((m) => m.cells[i])
        .filter((c): c is NonNullable<typeof c> => c != null);
      return {
        dueDate: p,
        expected: roundMoney(
          cells
            .filter((c) => c.status !== ContributionStatus.CANCELLED)
            .reduce((a, c) => a + c.amount, 0),
        ),
        collected: roundMoney(cells.reduce((a, c) => a + c.amountPaid, 0)),
        paidCount: cells.filter((c) => c.status === ContributionStatus.PAID)
          .length,
        lateCount: cells.filter((c) => c.status === ContributionStatus.LATE)
          .length,
      };
    });
    return {
      group: await this.groupName(groupId),
      fund,
      period: { from: r.from.toISOString(), to: r.to.toISOString() },
      periods,
      members: memberRows,
      periodTotals,
      totals: {
        expected: roundMoney(periodTotals.reduce((a, p) => a + p.expected, 0)),
        collected: roundMoney(
          periodTotals.reduce((a, p) => a + p.collected, 0),
        ),
      },
    };
  }

  // ── arrears & defaulters ────────────────────────────────────────────────

  async arrears(actorId: string, groupId: string) {
    await this.access.reader(actorId, groupId);
    const now = new Date();
    const [late, fines, loans, guarantees, members] = await Promise.all([
      this.prisma.contribution.findMany({
        where: { groupId, status: ContributionStatus.LATE },
        select: {
          userId: true,
          amount: true,
          amountPaid: true,
          dueDate: true,
          fund: true,
        },
      }),
      this.prisma.fine.findMany({
        where: { groupId, status: FineStatus.OPEN },
      }),
      this.prisma.memberLoan.findMany({
        where: {
          groupId,
          status: { in: [MemberLoanStatus.ACTIVE, MemberLoanStatus.DEFAULTED] },
        },
        include: { installments: true },
      }),
      this.prisma.loanGuarantor.findMany({
        where: { groupId, status: GuarantorStatus.CALLED },
      }),
      this.prisma.userGroup.findMany({
        where: { groupId },
        include: { user: { select: { fullName: true, phoneNumber: true } } },
      }),
    ]);
    const rows = new Map<
      string,
      {
        userId: string;
        name: string;
        phone: string | null;
        membershipStatus: string;
        lateContributions: number;
        lateAmount: number;
        oldestLateDueDate: string | null;
        openFines: number;
        overdueLoanAmount: number;
        daysOverdue: number;
        defaulted: boolean;
        calledGuarantees: number;
      }
    >();
    const row = (userId: string) => {
      let r = rows.get(userId);
      if (!r) {
        const m = members.find((x) => x.userId === userId);
        r = {
          userId,
          name: m?.user.fullName ?? 'Unknown',
          phone: m?.user.phoneNumber ?? null,
          membershipStatus: m?.membershipStatus ?? 'EXITED',
          lateContributions: 0,
          lateAmount: 0,
          oldestLateDueDate: null,
          openFines: 0,
          overdueLoanAmount: 0,
          daysOverdue: 0,
          defaulted: false,
          calledGuarantees: 0,
        };
        rows.set(userId, r);
      }
      return r;
    };
    for (const c of late) {
      const r = row(c.userId);
      r.lateContributions++;
      r.lateAmount = roundMoney(
        r.lateAmount + decN(c.amount) - decN(c.amountPaid),
      );
      const d = c.dueDate.toISOString();
      if (!r.oldestLateDueDate || d < r.oldestLateDueDate)
        r.oldestLateDueDate = d;
    }
    for (const f of fines) {
      const r = row(f.userId);
      r.openFines = roundMoney(
        r.openFines + decN(f.amount) - decN(f.amountPaid),
      );
    }
    for (const l of loans) {
      const overdue = l.installments.filter(
        (i) =>
          i.dueDate < now &&
          decN(i.principal) + decN(i.interest) - decN(i.amountPaid) > EPS,
      );
      if (
        overdue.length === 0 &&
        l.status !== MemberLoanStatus.DEFAULTED &&
        decN(l.penaltyAccrued) < EPS
      )
        continue;
      const r = row(l.userId);
      r.overdueLoanAmount = roundMoney(
        r.overdueLoanAmount +
          decN(l.penaltyAccrued) +
          overdue.reduce(
            (a, i) =>
              a + decN(i.principal) + decN(i.interest) - decN(i.amountPaid),
            0,
          ),
      );
      if (overdue.length) {
        const oldest = overdue.reduce((a, b) =>
          a.dueDate < b.dueDate ? a : b,
        );
        r.daysOverdue = Math.max(
          r.daysOverdue,
          Math.floor((now.getTime() - oldest.dueDate.getTime()) / DAY_MS),
        );
      }
      if (l.status === MemberLoanStatus.DEFAULTED) r.defaulted = true;
    }
    for (const g of guarantees) {
      const left = roundMoney(decN(g.calledAmount) - decN(g.paidAmount));
      if (left > EPS)
        row(g.guarantorUserId).calledGuarantees = roundMoney(
          row(g.guarantorUserId).calledGuarantees + left,
        );
    }
    const list = [...rows.values()]
      .map((r) => ({
        ...r,
        total: roundMoney(
          r.lateAmount + r.openFines + r.overdueLoanAmount + r.calledGuarantees,
        ),
      }))
      .filter((r) => r.total > EPS || r.defaulted)
      .sort(
        (a, b) =>
          Number(b.defaulted) - Number(a.defaulted) || b.total - a.total,
      );
    return {
      group: await this.groupName(groupId),
      asOf: now.toISOString(),
      members: list,
      totals: {
        members: list.length,
        defaulters: list.filter((x) => x.defaulted).length,
        lateAmount: roundMoney(list.reduce((a, x) => a + x.lateAmount, 0)),
        openFines: roundMoney(list.reduce((a, x) => a + x.openFines, 0)),
        overdueLoanAmount: roundMoney(
          list.reduce((a, x) => a + x.overdueLoanAmount, 0),
        ),
        total: roundMoney(list.reduce((a, x) => a + x.total, 0)),
      },
    };
  }

  // ── loan portfolio ──────────────────────────────────────────────────────

  async loanPortfolio(actorId: string, groupId: string, r: Range) {
    await this.access.reader(actorId, groupId);
    const now = new Date();
    const loans = await this.prisma.memberLoan.findMany({
      where: { groupId },
      include: {
        installments: true,
        user: { select: { fullName: true } },
        disbursement: true,
      },
      orderBy: { disbursedAt: 'desc' },
    });
    const open = loans.filter(
      (l) =>
        l.status === MemberLoanStatus.ACTIVE ||
        l.status === MemberLoanStatus.DEFAULTED,
    );
    const active = open.map((l) => {
      let principalLeft = 0;
      let oldestOverdue: Date | null = null;
      for (const i of l.installments) {
        const total = decN(i.principal) + decN(i.interest);
        const left = total - decN(i.amountPaid);
        if (left < EPS) continue;
        principalLeft += total > EPS ? decN(i.principal) * (left / total) : 0;
        if (i.dueDate < now && (!oldestOverdue || i.dueDate < oldestOverdue))
          oldestOverdue = i.dueDate;
      }
      const daysOverdue = oldestOverdue
        ? Math.floor((now.getTime() - oldestOverdue.getTime()) / DAY_MS)
        : 0;
      const bucket =
        daysOverdue === 0
          ? 'CURRENT'
          : daysOverdue <= 30
            ? '1-30'
            : daysOverdue <= 60
              ? '31-60'
              : daysOverdue <= 90
                ? '61-90'
                : '90+';
      return {
        id: l.id,
        borrower: l.user.fullName,
        disbursedAt: l.disbursedAt.toISOString(),
        dueDate: l.dueDate.toISOString(),
        principal: decN(l.principalAmount),
        principalOutstanding: roundMoney(principalLeft),
        outstanding: loanBalances(l).outstanding,
        penalty: decN(l.penaltyAccrued),
        status: l.status,
        daysOverdue,
        bucket,
      };
    });
    const portfolio = roundMoney(
      active.reduce((a, l) => a + l.principalOutstanding, 0),
    );
    const par = (days: number) => {
      const atRisk = active
        .filter((l) => l.daysOverdue > days)
        .reduce((a, l) => a + l.principalOutstanding, 0);
      return {
        amount: roundMoney(atRisk),
        percent:
          portfolio > EPS ? Math.round((atRisk / portfolio) * 10000) / 100 : 0,
      };
    };
    const flows = await this.prisma.ledgerEntry.groupBy({
      by: ['type', 'direction'],
      where: { groupId, occurredAt: { gte: r.from, lte: r.to } },
      _sum: { amount: true },
    });
    const flow = (t: LedgerEntryType, d: LedgerDirection) =>
      roundMoney(
        decN(flows.find((f) => f.type === t && f.direction === d)?._sum.amount),
      );
    const inRange = (d: Date | null) => d != null && d >= r.from && d <= r.to;
    const disbursed = loans.filter((l) =>
      inRange(
        l.disbursement?.status === LoanDisbursementStatus.COMPLETED
          ? l.disbursement.completedAt
          : l.disbursement
            ? null
            : l.disbursedAt,
      ),
    );
    const buckets = ['CURRENT', '1-30', '31-60', '61-90', '90+'].map((b) => {
      const ls = active.filter((l) => l.bucket === b);
      return {
        bucket: b,
        loans: ls.length,
        principalOutstanding: roundMoney(
          ls.reduce((a, l) => a + l.principalOutstanding, 0),
        ),
      };
    });
    const count = (s: MemberLoanStatus) =>
      loans.filter((l) => l.status === s).length;
    return {
      group: await this.groupName(groupId),
      asOf: now.toISOString(),
      period: { from: r.from.toISOString(), to: r.to.toISOString() },
      counts: {
        active: count(MemberLoanStatus.ACTIVE),
        defaulted: count(MemberLoanStatus.DEFAULTED),
        repaid: count(MemberLoanStatus.REPAID),
        writtenOff: count(MemberLoanStatus.WRITTEN_OFF),
        overdue: active.filter((l) => l.daysOverdue > 0).length,
      },
      portfolio: {
        principalOutstanding: portfolio,
        totalOutstanding: roundMoney(
          active.reduce((a, l) => a + l.outstanding, 0),
        ),
        par30: par(30),
        par60: par(60),
        par90: par(90),
      },
      buckets,
      periodFlows: {
        disbursedCount: disbursed.length,
        disbursedAmount: roundMoney(
          disbursed.reduce((a, l) => a + decN(l.principalAmount), 0),
        ),
        principalRepaid: flow(
          LedgerEntryType.LOAN_PRINCIPAL,
          LedgerDirection.IN,
        ),
        interestEarned: flow(LedgerEntryType.LOAN_INTEREST, LedgerDirection.IN),
        penaltiesEarned: flow(LedgerEntryType.LOAN_PENALTY, LedgerDirection.IN),
        writtenOff: roundMoney(
          loans
            .filter((l) => inRange(l.writtenOffAt))
            .reduce((a, l) => a + decN(l.writtenOffAmount), 0),
        ),
      },
      loans: active.sort((a, b) => b.daysOverdue - a.daysOverdue),
    };
  }

  // ── cash book ───────────────────────────────────────────────────────────

  async cashBook(
    actorId: string,
    groupId: string,
    r: Range,
    fund: FundType | 'ALL' = FundType.SAVINGS,
  ) {
    await this.access.reader(actorId, groupId);
    await this.cash.ensureLedger(groupId);
    const fundWhere = fund === 'ALL' ? {} : { fund };
    const before = await this.prisma.ledgerEntry.groupBy({
      by: ['direction'],
      where: { groupId, ...fundWhere, occurredAt: { lt: r.from } },
      _sum: { amount: true },
    });
    const opening = roundMoney(
      decN(
        before.find((b) => b.direction === LedgerDirection.IN)?._sum.amount,
      ) -
        decN(
          before.find((b) => b.direction === LedgerDirection.OUT)?._sum.amount,
        ),
    );
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { groupId, ...fundWhere, occurredAt: { gte: r.from, lte: r.to } },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
    });
    const users = await this.prisma.user.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              entries.map((e) => e.userId).filter((x): x is string => !!x),
            ),
          ],
        },
      },
      select: { id: true, fullName: true },
    });
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    let bal = opening;
    let totalIn = 0;
    let totalOut = 0;
    const lines = entries.map((e) => {
      const amt = decN(e.amount);
      const isIn = e.direction === LedgerDirection.IN;
      bal = roundMoney(bal + (isIn ? amt : -amt));
      if (isIn) totalIn += amt;
      else totalOut += amt;
      return {
        date: e.occurredAt.toISOString(),
        fund: e.fund,
        type: e.type,
        label: TYPE_LABEL[e.type],
        member: e.userId ? (name.get(e.userId) ?? null) : null,
        description: e.description,
        in: isIn ? amt : 0,
        out: isIn ? 0 : amt,
        balance: bal,
        reference: e.sourceKey,
      };
    });
    return {
      group: await this.groupName(groupId),
      fund,
      period: { from: r.from.toISOString(), to: r.to.toISOString() },
      openingBalance: opening,
      totalIn: roundMoney(totalIn),
      totalOut: roundMoney(totalOut),
      closingBalance: bal,
      lines,
    };
  }

  // ── share-out ───────────────────────────────────────────────────────────

  async shareOut(actorId: string, groupId: string, cycleId: string) {
    const so = await this.cycles.shareOut(actorId, groupId, cycleId, true);
    return { group: await this.groupName(groupId), ...so };
  }

  // ── receipt ─────────────────────────────────────────────────────────────

  async receipt(actorId: string, groupId: string, depositId: string) {
    const ctx = await this.access.member(actorId, groupId);
    const d = await this.prisma.depositRecord.findFirst({
      where: { id: depositId, groupId },
      include: {
        user: { select: { fullName: true, email: true, phoneNumber: true } },
        reviewedBy: { select: { fullName: true } },
        group: { select: { name: true } },
        allocations: {
          include: {
            contribution: { select: { dueDate: true, fund: true } },
            fine: { select: { reason: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!d) throw new NotFoundException('Payment not found.');
    if (d.userId !== actorId && !ctx.isLeader && !ctx.isSuperAdmin) {
      throw new ForbiddenException(
        'You can only download receipts for your own payments.',
      );
    }
    if (d.status !== DepositRecordStatus.CONFIRMED) {
      throw new BadRequestException(
        'A receipt is available once the payment is confirmed.',
      );
    }
    const at = d.reviewedAt ?? d.createdAt;
    return {
      receiptNumber: `RCPT-${at.toISOString().slice(0, 10).replace(/-/g, '')}-${d.id.slice(-6).toUpperCase()}`,
      group: d.group.name,
      member: {
        name: d.user.fullName,
        email: d.user.email,
        phone: d.user.phoneNumber,
      },
      depositId: d.id,
      paidAt: at.toISOString(),
      method: d.paymentMethod,
      providerTransactionId: d.providerTransactionId,
      confirmedBy:
        d.reviewedBy?.fullName ??
        (d.paymentMethod === 'MTN_MOMO' ? 'MTN MoMo' : null),
      amount: decN(d.amount),
      currency: d.currency,
      breakdown: {
        contribution: decN(d.contributionPortion),
        fines: decN(d.finePortion),
        loan: decN(d.installmentPortion),
      },
      lines: d.allocations.map((a) => ({
        kind: a.kind,
        amount: decN(a.amount),
        detail: a.contribution
          ? `${a.contribution.fund === FundType.SOCIAL ? 'Social fund' : 'Savings'} period due ${a.contribution.dueDate.toISOString().slice(0, 10)}`
          : a.fine
            ? a.fine.reason
            : a.memberLoanId
              ? a.kind === 'LOAN_PENALTY'
                ? 'Loan penalty'
                : 'Loan repayment'
              : '',
      })),
    };
  }

  // ── dashboard charts ────────────────────────────────────────────────────

  /** Monthly series for the last `months` months + key figures (any member). */
  async groupDashboard(actorId: string, groupId: string, months = 12) {
    await this.access.member(actorId, groupId);
    await this.cash.ensureLedger(groupId);
    const n = Math.min(36, Math.max(3, months));
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1),
    );
    const keys = Array.from({ length: n }, (_, i) =>
      monthKey(
        new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)),
      ),
    );
    const rows = await this.prisma.$queryRaw<
      {
        m: Date;
        type: LedgerEntryType;
        direction: LedgerDirection;
        fund: FundType;
        s: number;
        mine: number;
      }[]
    >(Prisma.sql`
      SELECT date_trunc('month', "occurredAt") AS m, type, direction, fund,
             SUM(amount)::float AS s,
             SUM(CASE WHEN "userId" = ${actorId} THEN amount ELSE 0 END)::float AS mine
      FROM ledger_entries
      WHERE "groupId" = ${groupId} AND "occurredAt" >= ${start}
      GROUP BY 1, 2, 3, 4`);
    const before = await this.prisma.ledgerEntry.groupBy({
      by: ['type', 'direction', 'fund'],
      where: { groupId, occurredAt: { lt: start } },
      _sum: { amount: true },
    });
    const sumBefore = (
      pred: (b: (typeof before)[number]) => boolean,
      sign: (b: (typeof before)[number]) => number,
    ) =>
      before
        .filter(pred)
        .reduce((a, b) => a + sign(b) * decN(b._sum.amount), 0);
    let savingsBal = sumBefore(
      (b) => b.fund === FundType.SAVINGS,
      (b) => (b.direction === LedgerDirection.IN ? 1 : -1),
    );
    let socialBal = sumBefore(
      (b) => b.fund === FundType.SOCIAL,
      (b) => (b.direction === LedgerDirection.IN ? 1 : -1),
    );
    let lent = sumBefore(
      (b) =>
        b.type === LedgerEntryType.LOAN_DISBURSEMENT ||
        b.type === LedgerEntryType.LOAN_PRINCIPAL,
      (b) => (b.type === LedgerEntryType.LOAN_DISBURSEMENT ? 1 : -1),
    );
    const mineBefore = await this.prisma.ledgerEntry.aggregate({
      where: {
        groupId,
        userId: actorId,
        type: LedgerEntryType.CONTRIBUTION,
        fund: FundType.SAVINGS,
        occurredAt: { lt: start },
      },
      _sum: { amount: true },
    });
    let mySavings = decN(mineBefore._sum.amount);
    const series = keys.map((k) => {
      const inMonth = rows.filter((x) => monthKey(new Date(x.m)) === k);
      const s = (
        pred: (x: (typeof rows)[number]) => boolean,
        field: 's' | 'mine' = 's',
      ) =>
        roundMoney(
          inMonth.filter(pred).reduce((a, x) => a + Number(x[field]), 0),
        );
      const savingsIn = s(
        (x) =>
          x.type === LedgerEntryType.CONTRIBUTION &&
          x.fund === FundType.SAVINGS,
      );
      const loansOut = s((x) => x.type === LedgerEntryType.LOAN_DISBURSEMENT);
      const principalIn = s((x) => x.type === LedgerEntryType.LOAN_PRINCIPAL);
      const repaymentsIn = roundMoney(
        principalIn +
          s(
            (x) =>
              x.type === LedgerEntryType.LOAN_INTEREST ||
              x.type === LedgerEntryType.LOAN_PENALTY,
          ),
      );
      savingsBal +=
        s(
          (x) =>
            x.fund === FundType.SAVINGS && x.direction === LedgerDirection.IN,
        ) -
        s(
          (x) =>
            x.fund === FundType.SAVINGS && x.direction === LedgerDirection.OUT,
        );
      socialBal +=
        s(
          (x) =>
            x.fund === FundType.SOCIAL && x.direction === LedgerDirection.IN,
        ) -
        s(
          (x) =>
            x.fund === FundType.SOCIAL && x.direction === LedgerDirection.OUT,
        );
      lent += loansOut - principalIn;
      mySavings += s(
        (x) =>
          x.type === LedgerEntryType.CONTRIBUTION &&
          x.fund === FundType.SAVINGS,
        'mine',
      );
      return {
        month: k,
        savingsIn,
        socialIn: s(
          (x) =>
            x.type === LedgerEntryType.CONTRIBUTION &&
            x.fund === FundType.SOCIAL,
        ),
        loansOut,
        repaymentsIn,
        income: s(
          (x) =>
            x.direction === LedgerDirection.IN &&
            (x.type === LedgerEntryType.LOAN_INTEREST ||
              x.type === LedgerEntryType.LOAN_PENALTY ||
              x.type === LedgerEntryType.FINE),
        ),
        expensesOut: s((x) => x.type === LedgerEntryType.EXPENSE),
        cashBalance: roundMoney(savingsBal),
        socialBalance: roundMoney(socialBal),
        loansOutstanding: roundMoney(Math.max(0, lent)),
        mySavings: roundMoney(mySavings),
      };
    });
    const pos = await this.cash.getCashPosition(groupId);
    const members = await this.prisma.userGroup.count({
      where: { groupId, membershipStatus: GroupMembershipStatus.ACTIVE },
    });
    return {
      group: await this.groupName(groupId),
      months: keys,
      series,
      kpis: {
        members,
        cash: pos.savingsBalance,
        socialFund: pos.socialBalance,
        availableForLoans: pos.available,
        loansOutstanding: series[series.length - 1]?.loansOutstanding ?? 0,
        mySavings: series[series.length - 1]?.mySavings ?? 0,
      },
    };
  }
}
