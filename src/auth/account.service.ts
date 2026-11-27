import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DeletionRequestStatus, Prisma, TwoFactorMethod } from '@prisma/client';
import { normalizePhone } from '../notifications/sms.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import type { UpdateProfileDto } from './dto/security.dto';
import { PhoneOtpService } from './phone-otp.service';

/** Profile, phone verification, data export and deletion requests (msfts §8). */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly otp: PhoneOtpService,
  ) {}

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phoneNumber: true, twoFactorMethod: true },
    });
    const data: Prisma.UserUpdateInput = {};
    if (dto.fullName !== undefined) data.fullName = dto.fullName.trim();
    if (dto.image !== undefined) data.image = dto.image;
    if (dto.phoneNumber !== undefined) {
      const smsTwoStep = u.twoFactorMethod === TwoFactorMethod.SMS;
      if (dto.phoneNumber === null || dto.phoneNumber.trim() === '') {
        if (smsTwoStep) {
          throw new BadRequestException(
            'Turn off SMS two-step verification before removing your phone.',
          );
        }
        Object.assign(data, {
          phoneNumber: null,
          phoneKey: null,
          phoneVerifiedAt: null,
        });
      } else {
        const key = normalizePhone(dto.phoneNumber);
        if (!key)
          throw new BadRequestException(
            'Enter a valid phone number, e.g. 0788123456.',
          );
        if (key !== normalizePhone(u.phoneNumber)) {
          if (smsTwoStep) {
            throw new BadRequestException(
              'Turn off SMS two-step verification before changing your phone.',
            );
          }
          const taken = await this.prisma.user.findFirst({
            where: { phoneKey: key, id: { not: userId } },
            select: { id: true },
          });
          if (taken)
            throw new ConflictException(
              'This phone number is used by another account.',
            );
          Object.assign(data, {
            phoneNumber: `+${key}`,
            phoneKey: key,
            phoneVerifiedAt: null,
          });
        }
      }
    }
    if (Object.keys(data).length) {
      await this.prisma.user.update({ where: { id: userId }, data });
    }
    return this.users.findById(userId);
  }

  async sendPhoneCode(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, phoneNumber: true, phoneVerifiedAt: true },
    });
    if (!u.phoneNumber)
      throw new BadRequestException('Add a phone number first.');
    if (u.phoneVerifiedAt)
      return { sent: false, message: 'This phone is already verified.' };
    if (!(await this.otp.send(u, 'VERIFY'))) {
      throw new BadRequestException('Could not send an SMS right now.');
    }
    return { sent: true, message: 'We sent a 6-digit code by SMS.' };
  }

  async verifyPhone(userId: string, code: string) {
    await this.otp.verify(userId, 'VERIFY', code);
    await this.prisma.user.update({
      where: { id: userId },
      data: { phoneVerifiedAt: new Date() },
    });
    return this.users.findById(userId);
  }

  /** Everything we hold about the person, as one JSON document (right of access). */
  async dataExport(userId: string) {
    const [
      user,
      memberships,
      contributions,
      deposits,
      loans,
      applications,
      fines,
      notifications,
      preferences,
      sessions,
      activity,
      sms,
      requests,
    ] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true,
          fullName: true,
          email: true,
          emailVerified: true,
          phoneNumber: true,
          phoneVerifiedAt: true,
          image: true,
          createdAt: true,
          lastLoginAt: true,
          passwordChangedAt: true,
          twoFactorMethod: true,
          twoFactorEnabledAt: true,
        },
      }),
      this.prisma.userGroup.findMany({
        where: { userId },
        select: {
          joinedAt: true,
          membershipStatus: true,
          exitedAt: true,
          role: { select: { name: true } },
          group: { select: { id: true, name: true } },
        },
      }),
      this.prisma.contribution.findMany({
        where: { userId },
        select: {
          groupId: true,
          fund: true,
          dueDate: true,
          amount: true,
          amountPaid: true,
          status: true,
          paidAt: true,
        },
        orderBy: { dueDate: 'asc' },
      }),
      this.prisma.depositRecord.findMany({
        where: { userId },
        select: {
          id: true,
          groupId: true,
          amount: true,
          platformFee: true,
          currency: true,
          paymentMethod: true,
          phone: true,
          status: true,
          purpose: true,
          createdAt: true,
          reviewedAt: true,
          rejectionReason: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.memberLoan.findMany({
        where: { userId },
        include: { installments: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.loanApplication.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.fine.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.userNotification.findMany({
        where: { userId },
        select: {
          type: true,
          title: true,
          body: true,
          groupId: true,
          createdAt: true,
          readAt: true,
          deliveredVia: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      }),
      this.prisma.notificationPreference.findMany({
        where: { userId },
        select: { channel: true, category: true, enabled: true },
      }),
      this.prisma.refreshToken.findMany({
        where: { userId },
        select: {
          createdAt: true,
          lastUsedAt: true,
          revokedAt: true,
          userAgent: true,
          ip: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.auditLog.findMany({
        where: {
          OR: [{ actorId: userId }, { entityType: 'User', entityId: userId }],
        },
        select: {
          createdAt: true,
          action: true,
          groupId: true,
          ip: true,
          userAgent: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      }),
      this.prisma.smsLog.findMany({
        where: { userId },
        select: {
          createdAt: true,
          to: true,
          message: true,
          kind: true,
          status: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      }),
      this.prisma.accountDeletionRequest.findMany({ where: { userId } }),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      notice:
        'Personal data held by E-kimina about you (Rwanda Law No. 058/2021 on the protection of personal data and privacy).',
      profile: user,
      memberships: memberships.map((m) => ({
        group: m.group,
        role: m.role.name,
        status: m.membershipStatus,
        joinedAt: m.joinedAt,
        exitedAt: m.exitedAt,
      })),
      contributions,
      deposits,
      loanApplications: applications,
      loans,
      fines,
      notifications,
      notificationPreferences: preferences,
      signIns: sessions,
      activity,
      smsMessages: sms,
      deletionRequests: requests,
    };
  }

  async deletionRequest(userId: string) {
    return this.prisma.accountDeletionRequest.findFirst({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
    });
  }

  /** What still ties the account to a group's money (must be settled before erasure). */
  async deletionBlockers(userId: string): Promise<string[]> {
    const [memberships, loans] = await Promise.all([
      this.prisma.userGroup.findMany({
        where: {
          userId,
          membershipStatus: { in: ['ACTIVE', 'SUSPENDED', 'PENDING_APPROVAL'] },
        },
        select: { group: { select: { name: true, deletedAt: true } } },
      }),
      this.prisma.memberLoan.count({
        where: { userId, status: { in: ['ACTIVE', 'DEFAULTED'] } },
      }),
    ]);
    const out: string[] = [];
    for (const m of memberships) {
      if (!m.group.deletedAt)
        out.push(
          `Still a member of ${m.group.name}: leave the group first (exit and settle).`,
        );
    }
    if (loans) out.push(`${loans} loan${loans === 1 ? '' : 's'} not repaid.`);
    return out;
  }

  async requestDeletion(userId: string, reason?: string) {
    const open = await this.prisma.accountDeletionRequest.findFirst({
      where: { userId, status: DeletionRequestStatus.PENDING },
    });
    if (open)
      return { request: open, blockers: await this.deletionBlockers(userId) };
    const request = await this.prisma.accountDeletionRequest.create({
      data: { userId, reason: reason?.trim() || null },
    });
    return { request, blockers: await this.deletionBlockers(userId) };
  }

  async cancelDeletion(userId: string) {
    const open = await this.prisma.accountDeletionRequest.findFirst({
      where: { userId, status: DeletionRequestStatus.PENDING },
    });
    if (!open) throw new NotFoundException('There is no pending request.');
    return this.prisma.accountDeletionRequest.update({
      where: { id: open.id },
      data: { status: DeletionRequestStatus.CANCELLED, decidedAt: new Date() },
    });
  }
}
