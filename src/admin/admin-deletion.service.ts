import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DeletionRequestStatus } from '@prisma/client';
import { hash } from 'bcryptjs';
import { AccountService } from '../auth/account.service';
import { TokensService } from '../auth/tokens.service';
import { EmailService } from '../email/email.service.js';
import { renderTemplate } from '../email/templates/base.template.js';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Right-to-erasure requests (Rwanda Law No. 058/2021). Approval anonymises the account;
 * group financial records stay (legal retention) but no longer identify the person.
 */
@Injectable()
export class AdminDeletionService {
  private readonly logger = new Logger(AdminDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly account: AccountService,
    private readonly tokens: TokensService,
    private readonly email: EmailService,
  ) {}

  async list(status?: DeletionRequestStatus) {
    const rows = await this.prisma.accountDeletionRequest.findMany({
      where: status ? { status } : {},
      orderBy: { requestedAt: 'desc' },
      take: 200,
      include: {
        user: {
          select: { id: true, fullName: true, email: true, phoneNumber: true },
        },
      },
    });
    return Promise.all(
      rows.map(async (r) => ({
        ...r,
        dueBy: new Date(r.requestedAt.getTime() + 30 * 86400_000),
        blockers:
          r.status === DeletionRequestStatus.PENDING
            ? await this.account.deletionBlockers(r.userId)
            : [],
      })),
    );
  }

  private async pending(id: string) {
    const r = await this.prisma.accountDeletionRequest.findUnique({
      where: { id },
    });
    if (!r) throw new NotFoundException('Request not found.');
    if (r.status !== DeletionRequestStatus.PENDING) {
      throw new BadRequestException('This request was already handled.');
    }
    return r;
  }

  async reject(actorId: string, id: string, note: string) {
    await this.pending(id);
    return this.prisma.accountDeletionRequest.update({
      where: { id },
      data: {
        status: DeletionRequestStatus.REJECTED,
        decidedAt: new Date(),
        decidedById: actorId,
        decisionNote: note.trim(),
      },
    });
  }

  async approve(actorId: string, id: string, note?: string) {
    const r = await this.pending(id);
    const blockers = await this.account.deletionBlockers(r.userId);
    if (blockers.length) {
      throw new BadRequestException(`Cannot delete yet: ${blockers.join(' ')}`);
    }
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: r.userId },
    });
    if (process.env.SMTP_HOST?.trim() && u.emailVerified) {
      await this.email
        .sendEmail({
          to: u.email,
          subject: 'Your E-kimina account was deleted',
          html: renderTemplate(
            `<h2>Your account was deleted</h2><p>As you asked, your E-kimina account and personal details were removed. Group records of past contributions and loans are kept without your name, as the law requires.</p>`,
            { subject: 'Your E-kimina account was deleted' },
          ),
        })
        .catch((e: unknown) =>
          this.logger.warn(`farewell email failed: ${String(e)}`),
        );
    }
    const now = new Date();
    await this.tokens.revokeAll(u.id, 'account-deleted');
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: u.id },
        data: {
          fullName: 'Deleted user',
          email: `deleted-${u.id}@deleted.invalid`,
          phoneNumber: null,
          phoneKey: null,
          phoneVerifiedAt: null,
          image: null,
          passwordHash: await hash(randomBytes(32).toString('hex'), 10),
          emailVerified: false,
          emailVerificationOtpHash: null,
          passwordResetOtpHash: null,
          phoneOtpHash: null,
          twoFactorMethod: null,
          totpSecretEnc: null,
          totpPendingSecretEnc: null,
          twoFactorRecoveryCodes: [],
          suspendedAt: now,
          suspendedById: actorId,
          suspensionReason: 'Account deleted at the owner’s request.',
        },
      }),
      this.prisma.groupMemberProfile.deleteMany({ where: { userId: u.id } }),
      this.prisma.pushSubscription.deleteMany({ where: { userId: u.id } }),
      this.prisma.notificationPreference.deleteMany({
        where: { userId: u.id },
      }),
      this.prisma.userNotification.deleteMany({ where: { userId: u.id } }),
      this.prisma.smsLog.updateMany({
        where: { userId: u.id },
        data: { to: 'deleted', message: '[removed]' },
      }),
      this.prisma.auditLog.updateMany({
        where: { actorId: u.id },
        data: { actorName: 'Deleted user', ip: null, userAgent: null },
      }),
      this.prisma.depositRecord.updateMany({
        where: { userId: u.id },
        data: { phone: null },
      }),
      this.prisma.accountDeletionRequest.update({
        where: { id },
        data: {
          status: DeletionRequestStatus.APPROVED,
          decidedAt: now,
          decidedById: actorId,
          decisionNote: note?.trim() || null,
        },
      }),
    ]);
    return { deleted: true };
  }
}
