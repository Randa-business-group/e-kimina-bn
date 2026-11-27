import { Injectable, NotFoundException } from '@nestjs/common';
import {
  GroupMembershipStatus,
  MemberLoanStatus,
  Prisma,
  RoleName,
} from '@prisma/client';
import { PaymentAccountsService } from '../platform/payment-accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminGroupsQueryDto } from './dto/admin.dto';

type Balances = Map<string, { savings: number; social: number }>;

/** Platform group administration (msfts §6). Verify / reject / restore reuse /groups routes. */
@Injectable()
export class AdminGroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: PaymentAccountsService,
  ) {}

  private async balances(groupIds: string[]): Promise<Balances> {
    const out: Balances = new Map(
      groupIds.map((id) => [id, { savings: 0, social: 0 }]),
    );
    if (!groupIds.length) return out;
    const rows = await this.prisma.ledgerEntry.groupBy({
      by: ['groupId', 'fund', 'direction'],
      where: { groupId: { in: groupIds } },
      _sum: { amount: true },
    });
    for (const r of rows) {
      const b = out.get(r.groupId)!;
      const v = Number(r._sum.amount ?? 0) * (r.direction === 'IN' ? 1 : -1);
      if (r.fund === 'SOCIAL') b.social += v;
      else b.savings += v;
    }
    for (const b of out.values()) {
      b.savings = Math.round(b.savings * 100) / 100;
      b.social = Math.round(b.social * 100) / 100;
    }
    return out;
  }

  async list(q: AdminGroupsQueryDto) {
    const pageSize = Math.min(100, q.pageSize ?? 25);
    const page = q.page ?? 1;
    const s = q.search?.trim();
    const where: Prisma.GroupWhereInput = {
      ...(s
        ? {
            OR: [
              { name: { contains: s, mode: 'insensitive' } },
              { id: s },
              { createdBy: { email: { contains: s, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(q.verification ? { verificationStatus: q.verification } : {}),
      ...(q.deleted === 'only'
        ? { deletedAt: { not: null } }
        : q.deleted === 'include'
          ? {}
          : { deletedAt: null }),
    };
    const [total, rows, byStatus] = await Promise.all([
      this.prisma.group.count({ where }),
      this.prisma.group.findMany({
        where,
        orderBy: [
          { verificationRequestedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          isPublic: true,
          createdAt: true,
          maxMembers: true,
          verificationStatus: true,
          verificationRequestedAt: true,
          verificationRejectionReason: true,
          deletedAt: true,
          deletionReason: true,
          createdBy: { select: { id: true, fullName: true, email: true } },
          paymentAccount: { select: { isActive: true } },
          _count: {
            select: {
              userGroups: {
                where: { membershipStatus: GroupMembershipStatus.ACTIVE },
              },
            },
          },
        },
      }),
      this.prisma.group.groupBy({
        by: ['verificationStatus'],
        where: { deletedAt: null },
        _count: { _all: true },
      }),
    ]);
    const bal = await this.balances(rows.map((r) => r.id));
    return {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      counts: {
        ...Object.fromEntries(
          byStatus.map((b) => [b.verificationStatus, b._count._all]),
        ),
        deleted: await this.prisma.group.count({
          where: { deletedAt: { not: null } },
        }),
      },
      items: rows.map(({ _count, paymentAccount, ...r }) => ({
        ...r,
        members: _count.userGroups,
        hasPaymentAccount: Boolean(paymentAccount?.isActive),
        savingsBalance: bal.get(r.id)?.savings ?? 0,
        socialBalance: bal.get(r.id)?.social ?? 0,
      })),
    };
  }

  async detail(groupId: string) {
    const g = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: {
        createdBy: {
          select: { id: true, fullName: true, email: true, phoneNumber: true },
        },
        contributionConfig: {
          select: { amount: true, currency: true, interval: true },
        },
      },
    });
    if (!g) throw new NotFoundException('Group not found.');
    const [members, leaders, loans, bal, account, audit, reviewer] =
      await Promise.all([
        this.prisma.userGroup.groupBy({
          by: ['membershipStatus'],
          where: { groupId },
          _count: { _all: true },
        }),
        this.prisma.userGroup.findMany({
          where: {
            groupId,
            membershipStatus: GroupMembershipStatus.ACTIVE,
            role: { name: { in: [RoleName.GROUP_ADMIN, RoleName.TREASURER] } },
          },
          select: {
            role: { select: { name: true } },
            user: {
              select: {
                id: true,
                fullName: true,
                email: true,
                phoneNumber: true,
              },
            },
          },
        }),
        this.prisma.memberLoan.groupBy({
          by: ['status'],
          where: { groupId },
          _count: { _all: true },
        }),
        this.balances([groupId]),
        this.accounts.get(groupId),
        this.prisma.auditLog.findMany({
          where: { groupId },
          orderBy: { createdAt: 'desc' },
          take: 15,
          select: {
            id: true,
            createdAt: true,
            action: true,
            actorName: true,
            actorId: true,
          },
        }),
        g.verificationReviewedById
          ? this.prisma.user.findUnique({
              where: { id: g.verificationReviewedById },
              select: { fullName: true },
            })
          : null,
      ]);
    const loanCount = (s: MemberLoanStatus) =>
      loans.find((l) => l.status === s)?._count._all ?? 0;
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      isPublic: g.isPublic,
      createdAt: g.createdAt,
      createdBy: g.createdBy,
      maxMembers: g.maxMembers,
      minMembers: g.minMembers,
      verification: {
        status: g.verificationStatus,
        requestedAt: g.verificationRequestedAt,
        details: g.verificationDetails,
        reviewedAt: g.verificationReviewedAt,
        reviewedBy: reviewer?.fullName ?? null,
        rejectionReason: g.verificationRejectionReason,
      },
      deletedAt: g.deletedAt,
      deletionReason: g.deletionReason,
      contribution: g.contributionConfig
        ? {
            amount: Number(g.contributionConfig.amount),
            currency: g.contributionConfig.currency,
            interval: g.contributionConfig.interval,
          }
        : null,
      members: Object.fromEntries(
        members.map((m) => [m.membershipStatus, m._count._all]),
      ),
      leaders: leaders.map((l) => ({ role: l.role.name, ...l.user })),
      loans: {
        active: loanCount(MemberLoanStatus.ACTIVE),
        defaulted: loanCount(MemberLoanStatus.DEFAULTED),
        repaid: loanCount(MemberLoanStatus.REPAID),
      },
      balances: bal.get(groupId) ?? { savings: 0, social: 0 },
      paymentAccount: account,
      recentActivity: audit,
    };
  }
}
