import { Injectable } from '@nestjs/common';
import {
  DepositRecordStatus,
  GroupMembershipStatus,
  GroupVerificationStatus,
  MemberLoanStatus,
  Prisma,
} from '@prisma/client';
import { DAY_MS, EPS, decN, roundMoney } from '../finance-core/money.util';
import { loanBalances } from '../finance-core/payment-allocation.service';
import { PrismaService } from '../prisma/prisma.service';

/** Platform metrics for super admins (msfts §5). */
@Injectable()
export class PlatformReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async metrics(months = 12) {
    const n = Math.min(36, Math.max(3, months));
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1),
    );
    const keys = Array.from({ length: n }, (_, i) =>
      new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))
        .toISOString()
        .slice(0, 7),
    );

    const [
      groupsByStatus,
      deletedGroups,
      users,
      activeUsers,
      verifiedUsers,
      memberships,
    ] = await Promise.all([
      this.prisma.group.groupBy({
        by: ['verificationStatus'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.group.count({ where: { deletedAt: { not: null } } }),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { emailVerified: true } }),
      this.prisma.userGroup.count({
        where: {
          membershipStatus: GroupMembershipStatus.ACTIVE,
          group: { deletedAt: null },
        },
      }),
    ]);
    const byStatus = (s: GroupVerificationStatus) =>
      groupsByStatus.find((g) => g.verificationStatus === s)?._count._all ?? 0;

    const deposits = await this.prisma.$queryRaw<
      { m: Date; method: string; c: bigint; s: number }[]
    >(Prisma.sql`
      SELECT date_trunc('month', COALESCE("reviewedAt", "createdAt")) AS m, "paymentMethod"::text AS method,
             COUNT(*)::bigint AS c, SUM(amount)::float AS s
      FROM deposit_records
      WHERE status = 'CONFIRMED'::"DepositRecordStatus" AND COALESCE("reviewedAt", "createdAt") >= ${start}
      GROUP BY 1, 2`);
    const payouts = await this.prisma.$queryRaw<
      { m: Date; c: bigint; s: number }[]
    >(Prisma.sql`
      SELECT date_trunc('month', "completedAt") AS m, COUNT(*)::bigint AS c, SUM(amount)::float AS s
      FROM loan_disbursements
      WHERE status = 'COMPLETED'::"LoanDisbursementStatus" AND "completedAt" >= ${start}
      GROUP BY 1`);
    const newUsers = await this.prisma.$queryRaw<
      { m: Date; c: bigint }[]
    >(Prisma.sql`
      SELECT date_trunc('month', "createdAt") AS m, COUNT(*)::bigint AS c
      FROM users WHERE "createdAt" >= ${start} GROUP BY 1`);
    const newGroups = await this.prisma.$queryRaw<
      { m: Date; c: bigint }[]
    >(Prisma.sql`
      SELECT date_trunc('month', "createdAt") AS m, COUNT(*)::bigint AS c
      FROM groups WHERE "createdAt" >= ${start} GROUP BY 1`);
    const mk = (d: Date) => new Date(d).toISOString().slice(0, 7);
    const series = keys.map((k) => {
      const dep = deposits.filter((d) => mk(d.m) === k);
      return {
        month: k,
        depositVolume: roundMoney(dep.reduce((a, d) => a + Number(d.s), 0)),
        depositCount: dep.reduce((a, d) => a + Number(d.c), 0),
        momoVolume: roundMoney(
          dep
            .filter((d) => d.method === 'MTN_MOMO')
            .reduce((a, d) => a + Number(d.s), 0),
        ),
        manualVolume: roundMoney(
          dep
            .filter((d) => d.method === 'MANUAL_TRANSFER')
            .reduce((a, d) => a + Number(d.s), 0),
        ),
        loansDisbursed: roundMoney(
          Number(payouts.find((p) => mk(p.m) === k)?.s ?? 0),
        ),
        newUsers: Number(newUsers.find((u) => mk(u.m) === k)?.c ?? 0),
        newGroups: Number(newGroups.find((g) => mk(g.m) === k)?.c ?? 0),
      };
    });

    const [allTime, openLoans] = await Promise.all([
      this.prisma.depositRecord.aggregate({
        where: { status: DepositRecordStatus.CONFIRMED },
        _sum: { amount: true, platformFee: true },
        _count: { _all: true },
      }),
      this.prisma.memberLoan.findMany({
        where: {
          status: { in: [MemberLoanStatus.ACTIVE, MemberLoanStatus.DEFAULTED] },
          group: { deletedAt: null },
        },
        include: { installments: true },
      }),
    ]);
    let portfolio = 0;
    let atRisk30 = 0;
    for (const l of openLoans) {
      const out = loanBalances(l).outstanding;
      portfolio += out;
      const oldest = l.installments
        .filter(
          (i) =>
            decN(i.principal) + decN(i.interest) - decN(i.amountPaid) > EPS &&
            i.dueDate < now,
        )
        .reduce<Date | null>(
          (a, i) => (!a || i.dueDate < a ? i.dueDate : a),
          null,
        );
      if (oldest && (now.getTime() - oldest.getTime()) / DAY_MS > 30)
        atRisk30 += out;
    }

    const top = await this.prisma.$queryRaw<
      { id: string; name: string; c: bigint; s: number }[]
    >(Prisma.sql`
      SELECT g.id, g.name, COUNT(d.id)::bigint AS c, SUM(d.amount)::float AS s
      FROM deposit_records d JOIN groups g ON g.id = d."groupId"
      WHERE d.status = 'CONFIRMED'::"DepositRecordStatus" AND g."deletedAt" IS NULL
      GROUP BY g.id, g.name ORDER BY s DESC LIMIT 10`);

    return {
      asOf: now.toISOString(),
      groups: {
        live: groupsByStatus.reduce((a, g) => a + g._count._all, 0),
        verified: byStatus(GroupVerificationStatus.VERIFIED),
        pendingVerification: byStatus(GroupVerificationStatus.PENDING),
        unverified: byStatus(GroupVerificationStatus.UNVERIFIED),
        rejected: byStatus(GroupVerificationStatus.REJECTED),
        deleted: deletedGroups,
      },
      users: {
        total: users,
        active: activeUsers,
        emailVerified: verifiedUsers,
        activeMemberships: memberships,
        suspended: await this.prisma.user.count({
          where: { suspendedAt: { not: null } },
        }),
        locked: await this.prisma.user.count({
          where: { lockedUntil: { gt: now } },
        }),
      },
      money: {
        depositVolumeAllTime: roundMoney(decN(allTime._sum.amount)),
        depositCountAllTime: allTime._count._all,
        platformFeesCollected: roundMoney(decN(allTime._sum.platformFee)),
        loansOutstanding: roundMoney(portfolio),
        openLoans: openLoans.length,
        par30Percent:
          portfolio > EPS
            ? Math.round((atRisk30 / portfolio) * 10000) / 100
            : 0,
        loansDisbursedInWindow: roundMoney(
          series.reduce((a, s) => a + s.loansDisbursed, 0),
        ),
      },
      series,
      topGroups: top.map((t) => ({
        id: t.id,
        name: t.name,
        deposits: Number(t.c),
        volume: roundMoney(Number(t.s)),
      })),
    };
  }
}
