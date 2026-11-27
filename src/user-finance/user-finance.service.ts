import { Injectable } from '@nestjs/common';
import {
  ContributionStatus,
  DepositPaymentMethod,
  DepositPurpose,
  DepositRecordStatus,
  FineStatus,
  FundType,
  GroupMembershipStatus,
  LoanApplicationStatus,
  LoanDisbursementStatus,
  Prisma,
} from '@prisma/client';
import { EPS, decN, roundMoney } from '../finance-core/money.util';
import {
  OPEN_LOAN_STATUSES,
  PAYABLE_LOAN_STATUSES,
  loanBalances,
} from '../finance-core/payment-allocation.service';
import { scheduleSnapshot } from '../finance-core/loan-installments';
import { PrismaService } from '../prisma/prisma.service';

const METHOD_LABEL: Record<DepositPaymentMethod, string> = {
  MTN_MOMO: 'MTN MoMo',
  MANUAL_TRANSFER: 'Manual transfer',
};

function depositDescription(d: {
  purpose: DepositPurpose;
  paymentMethod: DepositPaymentMethod;
  contributionPortion: Prisma.Decimal;
  finePortion: Prisma.Decimal;
  installmentPortion: Prisma.Decimal;
}) {
  const parts: string[] = [];
  if (decN(d.contributionPortion) > EPS) parts.push('contribution');
  if (decN(d.finePortion) > EPS)
    parts.push(
      d.purpose === DepositPurpose.LOAN_REPAYMENT ? 'loan penalty' : 'fines',
    );
  if (decN(d.installmentPortion) > EPS) parts.push('loan repayment');
  const what =
    parts.length === 0
      ? d.purpose === DepositPurpose.LOAN_REPAYMENT
        ? 'Loan repayment'
        : 'Contribution'
      : parts[0][0].toUpperCase() + parts.join(' + ').slice(1);
  return `${what} (${METHOD_LABEL[d.paymentMethod]})`;
}

@Injectable()
export class UserFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  private async liveMemberships(userId: string) {
    return this.prisma.userGroup.findMany({
      where: {
        userId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
        group: { deletedAt: null },
      },
      include: {
        group: { select: { id: true, name: true, isVerified: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }

  async getSummary(userId: string) {
    const memberships = (await this.liveMemberships(userId)).filter(
      (m) => m.group.isVerified,
    );
    const groupIds = memberships.map((m) => m.group.id);

    const groupBalances = await Promise.all(
      memberships.map(async (m) => {
        const [cc, paid, late, fines, loans] = await Promise.all([
          this.prisma.contributionConfig.findUnique({
            where: { groupId: m.group.id },
          }),
          this.prisma.contribution.groupBy({
            by: ['fund'],
            where: { userId, groupId: m.group.id },
            _sum: { amountPaid: true },
          }),
          this.prisma.contribution.findMany({
            where: {
              userId,
              groupId: m.group.id,
              status: ContributionStatus.LATE,
            },
            select: { amount: true, amountPaid: true },
          }),
          this.prisma.fine.findMany({
            where: { userId, groupId: m.group.id, status: FineStatus.OPEN },
            select: { amount: true, amountPaid: true },
          }),
          this.prisma.memberLoan.findMany({
            where: {
              userId,
              groupId: m.group.id,
              status: { in: PAYABLE_LOAN_STATUSES },
            },
          }),
        ]);
        return {
          groupId: m.group.id,
          groupName: m.group.name,
          /** Savings only (loan stake, share-out base). */
          totalContributed: roundMoney(
            decN(
              paid.find((p) => p.fund === FundType.SAVINGS)?._sum.amountPaid,
            ),
          ),
          socialFundContributed: roundMoney(
            decN(paid.find((p) => p.fund === FundType.SOCIAL)?._sum.amountPaid),
          ),
          arrears: roundMoney(
            late.reduce((s, r) => s + decN(r.amount) - decN(r.amountPaid), 0),
          ),
          lateContributions: late.length,
          openFines: roundMoney(
            fines.reduce((s, f) => s + decN(f.amount) - decN(f.amountPaid), 0),
          ),
          loanOutstanding: roundMoney(
            loans.reduce((s, l) => s + loanBalances(l).outstanding, 0),
          ),
          currency: cc?.currency ?? 'RWF',
          memberSince: m.joinedAt.toISOString(),
        };
      }),
    );

    const openFines =
      groupIds.length === 0
        ? []
        : await this.prisma.fine.findMany({
            where: {
              userId,
              groupId: { in: groupIds },
              status: FineStatus.OPEN,
            },
            include: {
              group: { select: { name: true } },
              contribution: { select: { dueDate: true } },
            },
            orderBy: { createdAt: 'asc' },
          });

    const penaltyBalances = openFines
      .map((f) => ({
        id: f.id,
        groupId: f.groupId,
        groupName: f.group.name,
        amount: roundMoney(decN(f.amount) - decN(f.amountPaid)),
        currency: f.currency,
        type: f.type,
        reason: f.reason,
        dueDate: (f.contribution?.dueDate ?? f.createdAt).toISOString(),
      }))
      .filter((p) => p.amount > EPS);

    return { groupBalances, penaltyBalances };
  }

  /**
   * One line per real money movement: confirmed payments (debits from the member's point of
   * view) and completed loan payouts (credits). Paid contribution rows are not listed again.
   */
  async getHistory(userId: string, page: number, pageSize: number) {
    const p = Math.max(1, page);
    const ps = Math.min(100, Math.max(1, pageSize));
    const skip = (p - 1) * ps;

    const [countRow] = await this.prisma.$queryRaw<[{ c: bigint }]>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS c FROM (
          SELECT d.id FROM deposit_records d
          JOIN groups g ON g.id = d."groupId" AND g."deletedAt" IS NULL
          WHERE d."userId" = ${userId} AND d.status = 'CONFIRMED'::"DepositRecordStatus"
          UNION ALL
          SELECT ld.id FROM loan_disbursements ld
          JOIN member_loans ml ON ml.id = ld."memberLoanId"
          JOIN groups g2 ON g2.id = ld."groupId" AND g2."deletedAt" IS NULL
          WHERE ml."userId" = ${userId} AND ld.status = 'COMPLETED'::"LoanDisbursementStatus"
        ) t
      `,
    );
    const totalItems = Number(countRow?.c ?? 0n);
    const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / ps);

    const page_ = await this.prisma.$queryRaw<
      { id: string; kind: string; eventAt: Date }[]
    >(
      Prisma.sql`
        SELECT * FROM (
          SELECT d.id, 'DEPOSIT'::text AS kind, COALESCE(d."reviewedAt", d."createdAt") AS "eventAt"
          FROM deposit_records d
          JOIN groups g ON g.id = d."groupId" AND g."deletedAt" IS NULL
          WHERE d."userId" = ${userId} AND d.status = 'CONFIRMED'::"DepositRecordStatus"
          UNION ALL
          SELECT ld.id, 'LOAN_DISBURSEMENT'::text, COALESCE(ld."completedAt", ld."createdAt")
          FROM loan_disbursements ld
          JOIN member_loans ml ON ml.id = ld."memberLoanId"
          JOIN groups g2 ON g2.id = ld."groupId" AND g2."deletedAt" IS NULL
          WHERE ml."userId" = ${userId} AND ld.status = 'COMPLETED'::"LoanDisbursementStatus"
        ) u
        ORDER BY u."eventAt" DESC
        LIMIT ${ps} OFFSET ${skip}
      `,
    );

    const depIds = page_.filter((r) => r.kind === 'DEPOSIT').map((r) => r.id);
    const disIds = page_
      .filter((r) => r.kind === 'LOAN_DISBURSEMENT')
      .map((r) => r.id);
    const [deps, dis] = await Promise.all([
      this.prisma.depositRecord.findMany({
        where: { id: { in: depIds } },
        include: { group: { select: { name: true } } },
      }),
      this.prisma.loanDisbursement.findMany({
        where: { id: { in: disIds } },
        include: { group: { select: { name: true } } },
      }),
    ]);
    const depById = new Map(deps.map((d) => [d.id, d]));
    const disById = new Map(dis.map((d) => [d.id, d]));

    type HistoryItem = {
      id: string;
      groupId: string;
      groupName: string;
      type: string;
      amount: number;
      currency: string;
      date: string;
      description: string;
      isCredit: boolean;
      status: 'COMPLETED';
      paymentMethod: DepositPaymentMethod | null;
      breakdown: { contribution: number; fine: number; loan: number } | null;
    };
    const items = page_.flatMap((r): HistoryItem[] => {
      if (r.kind === 'DEPOSIT') {
        const d = depById.get(r.id);
        if (!d) return [];
        const loanOnly =
          decN(d.installmentPortion) > EPS && decN(d.contributionPortion) < EPS;
        return [
          {
            id: d.id,
            groupId: d.groupId,
            groupName: d.group.name,
            type: loanOnly ? 'LOAN_REPAYMENT' : 'DEPOSIT',
            amount: roundMoney(decN(d.amount)),
            currency: d.currency,
            date: new Date(r.eventAt).toISOString(),
            description: depositDescription(d),
            isCredit: false,
            status: 'COMPLETED' as const,
            paymentMethod: d.paymentMethod,
            breakdown: {
              contribution: decN(d.contributionPortion),
              fine: decN(d.finePortion),
              loan: decN(d.installmentPortion),
            },
          },
        ];
      }
      const d = disById.get(r.id);
      if (!d) return [];
      return [
        {
          id: d.id,
          groupId: d.groupId,
          groupName: d.group.name,
          type: 'LOAN_DISBURSEMENT',
          amount: roundMoney(decN(d.amount)),
          currency: d.currency,
          date: new Date(r.eventAt).toISOString(),
          description:
            d.method === 'MTN_MOMO'
              ? 'Loan received (MTN MoMo)'
              : d.method === 'CASH'
                ? 'Loan received (cash)'
                : d.method === 'BANK_TRANSFER'
                  ? 'Loan received (bank transfer)'
                  : 'Loan disbursed',
          isCredit: true,
          status: 'COMPLETED' as const,
          paymentMethod: null,
          breakdown: null,
        },
      ];
    });

    return { items, totalItems, page: p, pageSize: ps, totalPages };
  }

  async getUpcoming(userId: string) {
    const memberships = (await this.liveMemberships(userId)).filter(
      (m) => m.group.isVerified,
    );
    const groupIds = memberships.map((m) => m.groupId);
    const nameByGid = new Map(
      memberships.map((m) => [m.groupId, m.group.name]),
    );
    if (groupIds.length === 0) return { items: [] };

    const [rows, fines, configs, pendingDeposits, loans] = await Promise.all([
      this.prisma.contribution.findMany({
        where: {
          userId,
          groupId: { in: groupIds },
          status: {
            in: [
              ContributionStatus.PENDING,
              ContributionStatus.PARTIALLY_PAID,
              ContributionStatus.LATE,
            ],
          },
        },
        orderBy: { dueDate: 'asc' },
      }),
      this.prisma.fine.findMany({
        where: { userId, groupId: { in: groupIds }, status: FineStatus.OPEN },
        include: { contribution: { select: { dueDate: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.contributionConfig.findMany({
        where: { groupId: { in: groupIds } },
      }),
      this.prisma.depositRecord.findMany({
        where: {
          userId,
          groupId: { in: groupIds },
          status: {
            in: [
              DepositRecordStatus.PENDING_VERIFICATION,
              DepositRecordStatus.PENDING,
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.memberLoan.findMany({
        where: {
          userId,
          groupId: { in: groupIds },
          status: { in: OPEN_LOAN_STATUSES },
        },
        include: { disbursement: { select: { status: true } } },
      }),
    ]);
    const currencyByGid = new Map(configs.map((c) => [c.groupId, c.currency]));
    const now = new Date();

    const items: {
      id: string;
      groupId: string;
      groupName: string;
      type: string;
      amount: number;
      currency: string;
      dueDate: string;
      description: string;
      status: string;
    }[] = [];

    for (const c of rows) {
      const remaining = roundMoney(decN(c.amount) - decN(c.amountPaid));
      if (remaining < EPS) continue;
      const day = c.dueDate.toISOString().slice(0, 10);
      items.push({
        id: c.id,
        groupId: c.groupId,
        groupName: nameByGid.get(c.groupId) ?? 'Group',
        type: 'CONTRIBUTION',
        amount: remaining,
        currency: currencyByGid.get(c.groupId) ?? 'RWF',
        dueDate: c.dueDate.toISOString(),
        description:
          decN(c.amountPaid) > EPS
            ? `Contribution due ${day} (rest of ${decN(c.amount).toFixed(0)})`
            : `Contribution due ${day}`,
        status:
          c.status === ContributionStatus.LATE || c.dueDate < now
            ? 'OVERDUE'
            : 'PENDING',
      });
    }

    for (const f of fines) {
      const remaining = roundMoney(decN(f.amount) - decN(f.amountPaid));
      if (remaining < EPS) continue;
      items.push({
        id: f.id,
        groupId: f.groupId,
        groupName: nameByGid.get(f.groupId) ?? 'Group',
        type: 'PENALTY',
        amount: remaining,
        currency: f.currency,
        dueDate: (f.contribution?.dueDate ?? f.createdAt).toISOString(),
        description: f.reason,
        status: 'OVERDUE',
      });
    }

    for (const l of loans) {
      if (
        l.disbursement &&
        l.disbursement.status !== LoanDisbursementStatus.COMPLETED
      )
        continue;
      const { outstanding } = loanBalances(l);
      if (outstanding < EPS) continue;
      // What is due now: penalty + overdue installments + the next one.
      const snap = await scheduleSnapshot(this.prisma, l, now, 0);
      const overdue = snap.overdueAmount > EPS;
      const next = snap.nextInstallment;
      items.push({
        id: l.id,
        groupId: l.groupId,
        groupName: nameByGid.get(l.groupId) ?? 'Group',
        type: 'LOAN',
        amount: Math.min(outstanding, snap.dueNow),
        currency: l.currency,
        dueDate: next?.dueDate ?? l.dueDate.toISOString(),
        description:
          l.status === 'DEFAULTED'
            ? 'Loan in default — repay as soon as possible'
            : overdue
              ? `Loan installments overdue (${snap.overdueAmount.toFixed(0)}) + next installment`
              : next
                ? `Loan installment ${next.number} due ${next.dueDate.slice(0, 10)}`
                : `Loan balance due ${l.dueDate.toISOString().slice(0, 10)}`,
        status: overdue ? 'OVERDUE' : 'PENDING',
      });
    }

    for (const d of pendingDeposits) {
      items.push({
        id: d.id,
        groupId: d.groupId,
        groupName: nameByGid.get(d.groupId) ?? 'Group',
        type: 'DEPOSIT',
        amount: decN(d.amount),
        currency: d.currency,
        dueDate: d.createdAt.toISOString(),
        description:
          d.status === DepositRecordStatus.PENDING
            ? 'MTN MoMo payment — waiting for approval on your phone'
            : 'Manual bank transfer — awaiting leader confirmation',
        status: 'PENDING_CONFIRMATION',
      });
    }

    return { items };
  }

  /** Member-facing: all loan applications and disbursed member loans for the current user. */
  async getUserLoans(userId: string) {
    const live = { group: { deletedAt: null } };
    const [applications, memberLoans] = await Promise.all([
      this.prisma.loanApplication.findMany({
        where: { userId, ...live },
        orderBy: { createdAt: 'desc' },
        include: {
          group: { select: { id: true, name: true } },
          memberLoan: { select: { id: true } },
        },
      }),
      this.prisma.memberLoan.findMany({
        where: { userId, ...live },
        orderBy: { createdAt: 'desc' },
        include: {
          group: { select: { id: true, name: true } },
          disbursement: true,
        },
      }),
    ]);
    const now = new Date();

    return {
      applications: applications.map((a) => {
        const gA = a.groupAdminApprovedAt != null;
        const tA = a.treasurerApprovedAt != null;
        return {
          id: a.id,
          groupId: a.groupId,
          groupName: a.group.name,
          requestedAmount: decN(a.requestedAmount),
          currency: a.currency,
          interestRate: decN(a.interestRateSnapshot),
          repaymentPeriodDays: a.repaymentPeriodDaysSnapshot,
          status: a.status,
          createdAt: a.createdAt.toISOString(),
          groupAdminApproved: gA,
          treasurerApproved: tA,
          waitingOn:
            a.status === LoanApplicationStatus.PENDING
              ? !gA && !tA
                ? 'GROUP_ADMIN_AND_TREASURER'
                : gA && !tA
                  ? 'TREASURER'
                  : !gA && tA
                    ? 'GROUP_ADMIN'
                    : null
              : null,
          rejectionReason: a.rejectionReason,
          rejectedAt: a.rejectedAt?.toISOString() ?? null,
          disbursedLoanId: a.memberLoan?.id ?? null,
        };
      }),
      memberLoans: memberLoans.map((l) => {
        const { penalty, outstanding } = loanBalances(l);
        return {
          id: l.id,
          groupId: l.groupId,
          groupName: l.group.name,
          applicationId: l.applicationId,
          principal: decN(l.principalAmount),
          totalRepayable: decN(l.totalRepayable),
          amountRepaid: decN(l.amountRepaid),
          penaltyAccrued: penalty,
          outstanding,
          currency: l.currency,
          interestRate: decN(l.interestRateSnapshot),
          repaymentPeriodDays: l.repaymentPeriodDaysSnapshot,
          disbursedAt: l.disbursedAt.toISOString(),
          dueDate: l.dueDate.toISOString(),
          originalDueDate: l.originalDueDate?.toISOString() ?? null,
          status: l.status,
          isOverdue:
            OPEN_LOAN_STATUSES.includes(l.status) &&
            l.dueDate < now &&
            outstanding > EPS,
          canRepay:
            PAYABLE_LOAN_STATUSES.includes(l.status) && outstanding > EPS,
          disbursementStatus: l.disbursement?.status ?? null,
          disbursementMethod: l.disbursement?.method ?? null,
        };
      }),
    };
  }

  /**
   * Dashboard home (msfts §5 / §9): everything the landing page needs in one call — my groups,
   * totals, what is due next, recent money movements, savings over the last 12 months and
   * upcoming meetings.
   */
  async getDashboard(userId: string) {
    const [user, memberships, summary, upcoming, history] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { fullName: true, email: true },
      }),
      this.prisma.userGroup.findMany({
        where: {
          userId,
          membershipStatus: GroupMembershipStatus.ACTIVE,
          group: { deletedAt: null },
        },
        include: {
          role: { select: { name: true } },
          group: {
            select: {
              id: true,
              name: true,
              isVerified: true,
              _count: {
                select: {
                  userGroups: {
                    where: { membershipStatus: GroupMembershipStatus.ACTIVE },
                  },
                },
              },
            },
          },
        },
        orderBy: { joinedAt: 'asc' },
      }),
      this.getSummary(userId),
      this.getUpcoming(userId),
      this.getHistory(userId, 1, 8),
    ]);
    const groupIds = memberships.map((m) => m.groupId);
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
    );
    const monthly =
      groupIds.length === 0
        ? []
        : await this.prisma.$queryRaw<{ m: Date; s: number }[]>(Prisma.sql`
            SELECT date_trunc('month', COALESCE(d."reviewedAt", d."createdAt")) AS m, SUM(a.amount)::float AS s
            FROM deposit_allocations a
            JOIN deposit_records d ON d.id = a."depositId"
            JOIN contributions c ON c.id = a."contributionId"
            WHERE d."userId" = ${userId} AND d.status = 'CONFIRMED'::"DepositRecordStatus"
              AND c.fund = 'SAVINGS'::"FundType" AND d."groupId" IN (${Prisma.join(groupIds)})
              AND COALESCE(d."reviewedAt", d."createdAt") >= ${start}
            GROUP BY 1`);
    const before =
      groupIds.length === 0
        ? 0
        : roundMoney(
            decN(
              (
                await this.prisma.contribution.aggregate({
                  where: {
                    userId,
                    groupId: { in: groupIds },
                    fund: FundType.SAVINGS,
                  },
                  _sum: { amountPaid: true },
                })
              )._sum.amountPaid,
            ) - monthly.reduce((a, x) => a + Number(x.s), 0),
          );
    let running = before;
    const savingsSeries = Array.from({ length: 12 }, (_, i) => {
      const key = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1),
      )
        .toISOString()
        .slice(0, 7);
      const saved = roundMoney(
        monthly
          .filter((x) => new Date(x.m).toISOString().slice(0, 7) === key)
          .reduce((a, x) => a + Number(x.s), 0),
      );
      running = roundMoney(running + saved);
      return { month: key, saved, total: running };
    });
    const meetings =
      groupIds.length === 0
        ? []
        : await this.prisma.meeting.findMany({
            where: {
              groupId: { in: groupIds },
              status: 'SCHEDULED',
              scheduledAt: {
                gte: now,
                lte: new Date(now.getTime() + 60 * 86_400_000),
              },
            },
            include: { group: { select: { name: true } } },
            orderBy: { scheduledAt: 'asc' },
            take: 10,
          });
    const balances = new Map(summary.groupBalances.map((b) => [b.groupId, b]));
    const nextDueByGroup = new Map<string, (typeof upcoming.items)[number]>();
    for (const it of [...upcoming.items].sort((a, b) =>
      a.dueDate.localeCompare(b.dueDate),
    )) {
      if (it.status === 'PENDING_CONFIRMATION') continue;
      if (!nextDueByGroup.has(it.groupId)) nextDueByGroup.set(it.groupId, it);
    }
    const groups = memberships.map((m) => {
      const b = balances.get(m.groupId);
      const next = nextDueByGroup.get(m.groupId);
      return {
        id: m.groupId,
        name: m.group.name,
        role: m.role.name,
        isVerified: m.group.isVerified,
        memberCount: m.group._count.userGroups,
        mySavings: b?.totalContributed ?? 0,
        socialFund: b?.socialFundContributed ?? 0,
        loanOutstanding: b?.loanOutstanding ?? 0,
        openFines: b?.openFines ?? 0,
        arrears: b?.arrears ?? 0,
        nextDue: next
          ? {
              amount: next.amount,
              dueDate: next.dueDate,
              description: next.description,
              status: next.status,
            }
          : null,
      };
    });
    const sum = (
      k:
        | 'mySavings'
        | 'socialFund'
        | 'loanOutstanding'
        | 'openFines'
        | 'arrears',
    ) => roundMoney(groups.reduce((a, g) => a + g[k], 0));
    const dueItems = upcoming.items.filter(
      (i) => i.status !== 'PENDING_CONFIRMATION',
    );
    return {
      user,
      totals: {
        groups: groups.length,
        savings: sum('mySavings'),
        socialFund: sum('socialFund'),
        loanOutstanding: sum('loanOutstanding'),
        openFines: sum('openFines'),
        overdue: roundMoney(
          dueItems
            .filter((i) => i.status === 'OVERDUE')
            .reduce((a, i) => a + i.amount, 0),
        ),
        dueNext30Days: roundMoney(
          dueItems
            .filter(
              (i) =>
                new Date(i.dueDate).getTime() <=
                now.getTime() + 30 * 86_400_000,
            )
            .reduce((a, i) => a + i.amount, 0),
        ),
      },
      groups,
      upcoming: [...upcoming.items]
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .slice(0, 8),
      recent: history.items,
      savingsSeries,
      meetings: meetings.map((mt) => ({
        id: mt.id,
        groupId: mt.groupId,
        groupName: mt.group.name,
        title: mt.title,
        scheduledAt: mt.scheduledAt.toISOString(),
        location: mt.location,
      })),
    };
  }
}
