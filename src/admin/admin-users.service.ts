import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DepositRecordStatus,
  MemberLoanStatus,
  Prisma,
  RoleName,
} from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AuthService } from '../auth/auth.service';
import { SmsService, normalizePhone } from '../notifications/sms.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import type { AdminUsersQueryDto } from './dto/admin.dto';

const IMPERSONATION_MINUTES = 30;

type Row = {
  id: string;
  fullName: string;
  email: string;
  phoneNumber: string | null;
  image: string | null;
  isActive: boolean;
  emailVerified: boolean;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  lockedUntil: Date | null;
  failedLoginAttempts: number;
  lastLoginAt: Date | null;
  createdAt: Date;
  platformRoles: { role: { name: RoleName } }[];
  _count: { userGroups: number };
};

const select = {
  id: true,
  fullName: true,
  email: true,
  phoneNumber: true,
  image: true,
  isActive: true,
  emailVerified: true,
  suspendedAt: true,
  suspensionReason: true,
  lockedUntil: true,
  failedLoginAttempts: true,
  lastLoginAt: true,
  createdAt: true,
  platformRoles: { take: 1, select: { role: { select: { name: true } } } },
  _count: {
    select: { userGroups: { where: { membershipStatus: 'ACTIVE' as const } } },
  },
} satisfies Prisma.UserSelect;

/** Platform user administration (msfts §6). */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly sms: SmsService,
  ) {}

  private status(
    u: Pick<Row, 'isActive' | 'emailVerified' | 'suspendedAt' | 'lockedUntil'>,
  ) {
    if (u.suspendedAt) return 'SUSPENDED';
    if (!u.isActive) return 'PENDING_INVITE';
    if (u.lockedUntil && u.lockedUntil > new Date()) return 'LOCKED';
    if (!u.emailVerified) return 'UNVERIFIED';
    return 'ACTIVE';
  }

  private view(u: Row) {
    const { platformRoles, _count, ...rest } = u;
    return {
      ...rest,
      platformRole: platformRoles[0]?.role.name ?? RoleName.USER,
      groups: _count.userGroups,
      status: this.status(u),
    };
  }

  async list(q: AdminUsersQueryDto) {
    const pageSize = Math.min(100, q.pageSize ?? 25);
    const page = q.page ?? 1;
    const now = new Date();
    const s = q.search?.trim();
    const and: Prisma.UserWhereInput[] = [];
    if (s) {
      and.push({
        OR: [
          { fullName: { contains: s, mode: 'insensitive' } },
          { email: { contains: s, mode: 'insensitive' } },
          { phoneNumber: { contains: s } },
          { id: s },
        ],
      });
    }
    if (q.role === 'SUPER_ADMIN') {
      and.push({
        platformRoles: { some: { role: { name: RoleName.SUPER_ADMIN } } },
      });
    } else if (q.role === 'USER') {
      and.push({
        platformRoles: { none: { role: { name: RoleName.SUPER_ADMIN } } },
      });
    }
    if (q.status === 'active') {
      and.push({
        suspendedAt: null,
        isActive: true,
        emailVerified: true,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      });
    } else if (q.status === 'suspended') {
      and.push({ suspendedAt: { not: null } });
    } else if (q.status === 'unverified') {
      and.push({ isActive: true, emailVerified: false, suspendedAt: null });
    } else if (q.status === 'pending') {
      and.push({ isActive: false });
    } else if (q.status === 'locked') {
      and.push({ lockedUntil: { gt: now } });
    }
    const finalWhere: Prisma.UserWhereInput = and.length ? { AND: and } : {};
    const [total, rows, counts] = await Promise.all([
      this.prisma.user.count({ where: finalWhere }),
      this.prisma.user.findMany({
        where: finalWhere,
        select,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.counts(),
    ]);
    return {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      counts,
      items: rows.map((r) => this.view(r)),
    };
  }

  private async counts() {
    const now = new Date();
    const [all, suspended, pending, unverified, locked] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { suspendedAt: { not: null } } }),
      this.prisma.user.count({ where: { isActive: false } }),
      this.prisma.user.count({
        where: { isActive: true, emailVerified: false, suspendedAt: null },
      }),
      this.prisma.user.count({ where: { lockedUntil: { gt: now } } }),
    ]);
    return { all, suspended, pending, unverified, locked };
  }

  private async load(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, select });
    if (!u) throw new NotFoundException('User not found.');
    return u;
  }

  async detail(id: string) {
    const u = await this.load(id);
    const [memberships, deposits, loans, audit] = await Promise.all([
      this.prisma.userGroup.findMany({
        where: { userId: id },
        select: {
          groupId: true,
          joinedAt: true,
          membershipStatus: true,
          role: { select: { name: true } },
          group: {
            select: { name: true, deletedAt: true, verificationStatus: true },
          },
        },
        orderBy: { joinedAt: 'desc' },
      }),
      this.prisma.depositRecord.aggregate({
        where: { userId: id, status: DepositRecordStatus.CONFIRMED },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.memberLoan.count({
        where: {
          userId: id,
          status: { in: [MemberLoanStatus.ACTIVE, MemberLoanStatus.DEFAULTED] },
        },
      }),
      this.prisma.auditLog.findMany({
        where: { OR: [{ actorId: id }, { entityType: 'User', entityId: id }] },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          createdAt: true,
          action: true,
          actorId: true,
          actorName: true,
          groupId: true,
          ip: true,
          statusCode: true,
        },
      }),
    ]);
    return {
      ...this.view(u),
      memberships: memberships.map((m) => ({
        groupId: m.groupId,
        groupName: m.group.name,
        groupDeleted: Boolean(m.group.deletedAt),
        groupVerification: m.group.verificationStatus,
        role: m.role.name,
        membershipStatus: m.membershipStatus,
        joinedAt: m.joinedAt,
      })),
      money: {
        confirmedDeposits: deposits._count._all,
        depositedTotal: Number(deposits._sum.amount ?? 0),
        openLoans: loans,
      },
      recentActivity: audit,
    };
  }

  private async target(actor: AuthenticatedUser, id: string) {
    if (actor.id === id) {
      throw new BadRequestException('You cannot do this to your own account.');
    }
    const u = await this.load(id);
    if (u.platformRoles[0]?.role.name === RoleName.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Super admin accounts cannot be changed here.',
      );
    }
    return u;
  }

  async suspend(actor: AuthenticatedUser, id: string, reason: string) {
    const u = await this.target(actor, id);
    if (u.suspendedAt)
      throw new BadRequestException('This account is already suspended.');
    await this.prisma.user.update({
      where: { id },
      data: {
        suspendedAt: new Date(),
        suspendedById: actor.id,
        suspensionReason: reason.trim(),
        sessionVersion: { increment: 1 },
      },
    });
    return this.detail(id);
  }

  async reactivate(actor: AuthenticatedUser, id: string) {
    const u = await this.target(actor, id);
    if (!u.suspendedAt)
      throw new BadRequestException('This account is not suspended.');
    await this.prisma.user.update({
      where: { id },
      data: { suspendedAt: null, suspendedById: null, suspensionReason: null },
    });
    return this.detail(id);
  }

  async unlock(id: string) {
    await this.load(id);
    await this.prisma.user.update({
      where: { id },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
    });
    return this.detail(id);
  }

  /** Sign the user out everywhere, clear a lockout and (optionally) email a reset code. */
  async resetAccess(
    actor: AuthenticatedUser,
    id: string,
    sendResetEmail = true,
  ) {
    const u = await this.target(actor, id);
    await this.prisma.user.update({
      where: { id },
      data: {
        sessionVersion: { increment: 1 },
        lockedUntil: null,
        failedLoginAttempts: 0,
      },
    });
    const canEmail =
      sendResetEmail &&
      (Boolean(process.env.SMTP_HOST?.trim()) ||
        (this.sms.enabled && Boolean(normalizePhone(u.phoneNumber)))) &&
      u.isActive &&
      u.emailVerified &&
      !u.suspendedAt;
    if (canEmail) await this.auth.forgotPassword({ email: u.email });
    return {
      sessionsRevoked: true,
      resetEmailSent: canEmail,
      message: canEmail
        ? 'All sessions ended. A password-reset code was sent to the user by email and/or SMS.'
        : 'All sessions ended. No reset email was sent (SMTP off, account not verified, suspended, or not requested).',
    };
  }

  async resendVerification(id: string) {
    const u = await this.load(id);
    if (u.emailVerified)
      throw new BadRequestException('This email is already verified.');
    if (!u.isActive) {
      throw new BadRequestException(
        'This person was invited and has not finished sign-up. Resend the invitation from the group.',
      );
    }
    if (
      !process.env.SMTP_HOST?.trim() &&
      !(this.sms.enabled && normalizePhone(u.phoneNumber))
    ) {
      throw new BadRequestException(
        'Neither email (SMTP) nor SMS to this person is available on this server.',
      );
    }
    await this.auth.resendVerification({ email: u.email });
    return {
      sent: true,
      message: `A new verification code was sent to ${u.email}.`,
    };
  }

  /** Support override when the person cannot receive the code. */
  async verifyEmail(id: string) {
    const u = await this.load(id);
    if (u.emailVerified)
      throw new BadRequestException('This email is already verified.');
    await this.prisma.user.update({
      where: { id },
      data: {
        emailVerified: true,
        emailVerificationOtpHash: null,
        emailVerificationExpiresAt: null,
      },
    });
    return this.detail(id);
  }

  /** Read-only session as the user, for support. Expires after 30 minutes. */
  async impersonate(actor: AuthenticatedUser, id: string) {
    if (actor.impersonatorId) {
      throw new ForbiddenException('End the current support session first.');
    }
    const u = await this.target(actor, id);
    if (!u.isActive) {
      throw new BadRequestException(
        'This person has not finished sign-up yet.',
      );
    }
    const profile = await this.users.findById(id);
    const accessToken = await this.auth.issueToken(
      profile,
      { imp: actor.id, ro: true },
      IMPERSONATION_MINUTES * 60,
    );
    return {
      accessToken,
      readOnly: true,
      expiresAt: new Date(Date.now() + IMPERSONATION_MINUTES * 60_000),
      user: profile,
    };
  }
}
