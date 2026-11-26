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
  DepositPaymentMethod,
  DepositPurpose,
  DepositRecord,
  DepositRecordStatus,
  FineStatus,
  GroupMembershipStatus,
  LoanApplicationStatus,
  MemberLoanStatus,
  NotificationType,
  Prisma,
  RoleName,
} from '@prisma/client';
import { EmailService } from '../email/email.service.js';
import { GroupCashService } from '../finance-core/group-cash.service';
import { EPS, dec, decN, roundMoney } from '../finance-core/money.util';
import {
  OPEN_LOAN_STATUSES,
  PaymentAllocationService,
  SettlementResult,
  loanBalances,
} from '../finance-core/payment-allocation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MomoService, type MomoStatusResult } from '../payments/momo.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupLoansService } from './group-loans.service';

export interface CreateDepositInput {
  amount: number;
  paymentMethod: DepositPaymentMethod;
  phone?: string;
  proofImageUrl?: string;
  memberLoanId?: string;
  /** Pay the open loan together with contributions / fines in one deposit. */
  includeLoanRepayment?: boolean;
  idempotencyKey?: string;
}

@Injectable()
export class GroupFinanceService {
  private readonly logger = new Logger(GroupFinanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly groupLoans: GroupLoansService,
    private readonly notifications: NotificationsService,
    private readonly allocation: PaymentAllocationService,
    private readonly cash: GroupCashService,
    private readonly momo: MomoService,
  ) {}

  // ── access helpers ──────────────────────────────────────────────────────

  private async requireLiveVerifiedGroup(groupId: string) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
    });
    if (!group || group.deletedAt) {
      throw new NotFoundException(`Group ${groupId} was not found.`);
    }
    if (!group.isVerified) {
      throw new ForbiddenException(
        'This action is only available for verified groups.',
      );
    }
    return group;
  }

  private async requireActiveMemberInVerifiedGroup(
    userId: string,
    groupId: string,
  ) {
    const group = await this.requireLiveVerifiedGroup(groupId);
    const membership = await this.prisma.userGroup.findFirst({
      where: {
        userId,
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
      },
      include: { role: true },
    });
    if (!membership) {
      throw new ForbiddenException(
        'You are not an active member of this group.',
      );
    }
    return { group, membership };
  }

  /** Group admin or treasurer (both may review payments, never their own). */
  private async requireGroupAdminOrTreasurerInVerifiedGroup(
    userId: string,
    groupId: string,
  ) {
    const group = await this.requireLiveVerifiedGroup(groupId);
    const membership = await this.prisma.userGroup.findFirst({
      where: {
        userId,
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
        role: { name: { in: [RoleName.GROUP_ADMIN, RoleName.TREASURER] } },
      },
      include: { role: true },
    });
    if (!membership) {
      throw new ForbiddenException(
        'Only a group admin or the treasurer can review or manage manual payment verification for this group.',
      );
    }
    return { group, membership };
  }

  private async getFinanceLeaderEmailsForGroup(
    groupId: string,
    excludeUserId?: string,
  ) {
    const rows = await this.prisma.userGroup.findMany({
      where: {
        groupId,
        ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
        membershipStatus: GroupMembershipStatus.ACTIVE,
        role: { name: { in: [RoleName.GROUP_ADMIN, RoleName.TREASURER] } },
      },
      include: { user: { select: { email: true, isActive: true } } },
    });
    return [
      ...new Set(
        rows
          .filter((r) => r.user.isActive)
          .map((r) => r.user.email.trim().toLowerCase()),
      ),
    ];
  }

  // ── deposit preview ─────────────────────────────────────────────────────

  async getDepositPreview(
    userId: string,
    groupId: string,
    opts: { includeLoan?: boolean } = {},
  ) {
    await this.requireActiveMemberInVerifiedGroup(userId, groupId);
    return this.computeDepositPreview(userId, groupId, opts);
  }

  private async computeDepositPreview(
    userId: string,
    groupId: string,
    opts: { includeLoan?: boolean },
  ) {
    const cc = await this.prisma.contributionConfig.findUnique({
      where: { groupId },
    });
    if (!cc) {
      return {
        configured: false as const,
        message: 'Contribution rules are not configured for this group yet.',
      };
    }

    const open = await this.allocation.getOpenObligations(groupId, userId);
    let contribution = open.contributionTotal;
    const fine = open.fineTotal;
    let isAdvancePayment = false;
    if (contribution + fine < EPS) {
      // Everything is paid: offer the next period in advance.
      const m = await this.prisma.userGroup.findUnique({
        where: { userId_groupId: { userId, groupId } },
        select: { customContributionAmount: true },
      });
      contribution =
        m?.customContributionAmount != null &&
        decN(m.customContributionAmount) > 0
          ? decN(m.customContributionAmount)
          : decN(cc.amount);
      isAdvancePayment = true;
    }

    const loan = await this.allocation.getPayableLoan(groupId, userId);
    const lb = loan ? loanBalances(loan) : null;
    const installment = opts.includeLoan && lb ? lb.outstanding : 0;
    const now = new Date();

    return {
      configured: true as const,
      currency: cc.currency ?? 'RWF',
      allowPartialPayments: cc.allowPartialPayments,
      contribution: roundMoney(contribution),
      fine: roundMoney(fine),
      installment: roundMoney(installment),
      total: roundMoney(contribution + fine + installment),
      isAdvancePayment,
      overdueContributions: open.rows.filter(
        (r) => r.row.status === ContributionStatus.LATE,
      ).length,
      openPeriods: open.rows.map((r) => ({
        id: r.row.id,
        dueDate: r.row.dueDate.toISOString(),
        amount: decN(r.row.amount),
        amountPaid: decN(r.row.amountPaid),
        remaining: r.remaining,
        status: r.row.status,
      })),
      openFines: open.fines.map((f) => ({
        id: f.fine.id,
        type: f.fine.type,
        reason: f.fine.reason,
        amount: decN(f.fine.amount),
        remaining: f.remaining,
      })),
      loan:
        loan && lb
          ? {
              memberLoanId: loan.id,
              status: loan.status,
              dueDate: loan.dueDate.toISOString(),
              isOverdue: loan.dueDate < now,
              penalty: lb.penalty,
              balance: lb.balance,
              outstanding: lb.outstanding,
              included: Boolean(opts.includeLoan),
            }
          : null,
    };
  }

  // ── create deposit ──────────────────────────────────────────────────────

  async createDeposit(
    userId: string,
    groupId: string,
    dto: CreateDepositInput,
  ) {
    const { group } = await this.requireActiveMemberInVerifiedGroup(
      userId,
      groupId,
    );

    const idemKey = dto.idempotencyKey?.trim() || null;
    if (idemKey) {
      const existing = await this.prisma.depositRecord.findUnique({
        where: { idempotencyKey: idemKey },
      });
      if (existing) {
        if (existing.userId !== userId || existing.groupId !== groupId) {
          throw new BadRequestException(
            'This idempotency key was already used.',
          );
        }
        return this.depositResponse(
          existing,
          'This payment was already submitted.',
        );
      }
    }

    if (
      dto.paymentMethod === DepositPaymentMethod.MANUAL_TRANSFER &&
      !dto.proofImageUrl?.trim()
    ) {
      throw new BadRequestException(
        'Upload a payment proof (receipt or screenshot) and pass proofImageUrl for manual transfer.',
      );
    }
    if (
      dto.paymentMethod === DepositPaymentMethod.MTN_MOMO &&
      !dto.phone?.trim()
    ) {
      throw new BadRequestException('Phone number is required for MTN MoMo.');
    }

    // What is being paid, how much is due, and whether partial amounts are allowed.
    let purpose: DepositPurpose;
    let memberLoanId: string | null = null;
    let total: number;
    let allowPartial: boolean;
    let currency: string;
    let split = { contribution: 0, fine: 0, installment: 0 };

    if (dto.memberLoanId?.trim()) {
      memberLoanId = dto.memberLoanId.trim();
      const lp = await this.groupLoans.getLoanRepaymentPreviewForMember(
        userId,
        groupId,
        memberLoanId,
      );
      if (!lp.configured) {
        throw new BadRequestException(
          lp.message ?? 'Loan repayment is not available.',
        );
      }
      purpose = DepositPurpose.LOAN_REPAYMENT;
      total = lp.total;
      allowPartial = lp.allowPartialPayments;
      currency = lp.currency;
      split = {
        contribution: 0,
        fine: lp.finePortion,
        installment: lp.installmentPortion,
      };
    } else {
      const p = await this.computeDepositPreview(userId, groupId, {
        includeLoan: dto.includeLoanRepayment,
      });
      if (!p.configured) {
        throw new BadRequestException(
          'Deposits are not available until contribution rules are configured.',
        );
      }
      purpose =
        dto.includeLoanRepayment && p.loan
          ? DepositPurpose.COMBINED
          : DepositPurpose.CONTRIBUTION;
      memberLoanId =
        purpose === DepositPurpose.COMBINED
          ? (p.loan?.memberLoanId ?? null)
          : null;
      total = p.total;
      allowPartial = p.allowPartialPayments;
      currency = p.currency;
      split = {
        contribution: p.contribution,
        fine: p.fine,
        installment: p.installment,
      };
    }

    if (total <= 0) {
      throw new BadRequestException('Nothing to pay for this period.');
    }
    if (!allowPartial) {
      if (Math.abs(dto.amount - total) > 0.01) {
        throw new BadRequestException(
          `This group requires the full amount (${total.toFixed(2)} ${currency}).`,
        );
      }
    } else if (dto.amount < 0.01 || dto.amount - total > 0.01) {
      throw new BadRequestException(
        `Amount must be between 0.01 and ${total.toFixed(2)} ${currency}.`,
      );
    }

    // Intended split, scaled for partial payments (final split comes from allocation).
    const ratio = total > 0 ? Math.min(1, dto.amount / total) : 1;
    const base = {
      userId,
      groupId,
      memberLoanId,
      purpose,
      amount: dec(dto.amount),
      currency,
      contributionPortion: dec(split.contribution * ratio),
      finePortion: dec(split.fine * ratio),
      installmentPortion: dec(
        Math.max(
          0,
          dto.amount -
            roundMoney(split.contribution * ratio) -
            roundMoney(split.fine * ratio),
        ),
      ),
      idempotencyKey: idemKey,
    };

    if (dto.paymentMethod === DepositPaymentMethod.MTN_MOMO) {
      return this.startMomoDeposit(group, base, dto.phone!.trim());
    }

    const created = await this.prisma.depositRecord.create({
      data: {
        ...base,
        paymentMethod: DepositPaymentMethod.MANUAL_TRANSFER,
        status: DepositRecordStatus.PENDING_VERIFICATION,
        proofImageUrl: dto.proofImageUrl!.trim(),
      },
    });
    await this.notifyManualSubmitted(created, group);
    return this.depositResponse(
      created,
      memberLoanId && purpose === DepositPurpose.LOAN_REPAYMENT
        ? 'Your loan repayment proof was submitted. A group admin or treasurer will review it and apply it to your loan.'
        : 'Your payment proof was submitted. A group admin or treasurer will review it and you will be notified by email.',
    );
  }

  private depositResponse(d: DepositRecord, message: string) {
    return {
      id: d.id,
      message,
      amount: decN(d.amount),
      currency: d.currency,
      status: d.status,
      purpose: d.purpose,
      failureReason: d.failureReason,
    };
  }

  private async notifyManualSubmitted(
    created: DepositRecord,
    group: { id: string; name: string },
  ) {
    const member = await this.prisma.user.findUnique({
      where: { id: created.userId },
      select: { fullName: true, email: true },
    });
    if (!member) return;
    const isLoan = created.purpose === DepositPurpose.LOAN_REPAYMENT;
    const leaderEmails = await this.getFinanceLeaderEmailsForGroup(
      group.id,
      created.userId,
    );
    try {
      await this.emailService.sendManualDepositPendingToGroupAdmins(
        leaderEmails,
        {
          groupName: group.name,
          memberName: member.fullName,
          memberEmail: member.email,
          amount: decN(created.amount).toFixed(2),
          currency: created.currency,
          depositId: created.id,
          groupId: group.id,
        },
      );
    } catch (e) {
      this.logger.error(
        `Failed to email group leaders about pending manual deposit: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    void this.notifications
      .notifyManualDepositPending({
        groupId: group.id,
        groupName: group.name,
        depositId: created.id,
        amount: decN(created.amount).toFixed(2),
        currency: created.currency,
        memberName: member.fullName,
        isLoanRepayment: isLoan,
      })
      .catch((e) => this.logger.error(e));
    void this.notifications
      .notifyMemberPaymentProofSubmitted({
        userId: created.userId,
        groupId: group.id,
        groupName: group.name,
        amount: decN(created.amount).toFixed(2),
        currency: created.currency,
        isLoanRepayment: isLoan,
      })
      .catch((e) => this.logger.error(e));
  }

  // ── MTN MoMo collections ────────────────────────────────────────────────

  private async startMomoDeposit(
    group: { id: string; name: string },
    base: Omit<
      Prisma.DepositRecordUncheckedCreateInput,
      'paymentMethod' | 'status'
    >,
    phone: string,
  ) {
    if (!this.momo.isEnabled('collection')) {
      throw new BadRequestException(
        'MTN MoMo payments are not available for now. Please use a manual transfer.',
      );
    }
    const msisdn = this.momo.normalizeMsisdn(phone);
    const referenceId = randomUUID();
    const created = await this.prisma.depositRecord.create({
      data: {
        ...base,
        paymentMethod: DepositPaymentMethod.MTN_MOMO,
        phone: msisdn,
        status: DepositRecordStatus.PENDING,
        externalReference: referenceId,
        providerStatus: 'CREATED',
      },
    });

    try {
      await this.momo.requestToPay({
        referenceId,
        amount: decN(created.amount),
        externalId: created.id,
        msisdn,
        payerMessage: `E-kimina: ${group.name}`,
        payeeNote: `Deposit ${created.id}`,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.prisma.depositRecord.update({
        where: { id: created.id },
        data: {
          status: DepositRecordStatus.FAILED,
          failureReason: reason,
          providerStatus: 'REQUEST_FAILED',
        },
      });
      throw e;
    }
    await this.prisma.depositRecord.update({
      where: { id: created.id },
      data: { providerStatus: 'PENDING' },
    });

    if (this.momo.isMock) {
      // Simulated provider: resolve immediately so dev flows stay instant.
      const final = await this.refreshMomoDeposit(created.id);
      return this.depositResponse(
        final,
        final.status === DepositRecordStatus.CONFIRMED
          ? 'MTN MoMo payment confirmed (simulated provider) and applied to your balance.'
          : `MTN MoMo payment failed: ${final.failureReason ?? 'declined'}.`,
      );
    }
    const fresh = await this.prisma.depositRecord.findUniqueOrThrow({
      where: { id: created.id },
    });
    return this.depositResponse(
      fresh,
      'A payment prompt was sent to your phone. Approve it with your MoMo PIN; your balance updates as soon as MTN confirms.',
    );
  }

  /** Ask MTN for the status of a PENDING MoMo deposit and settle or fail it. */
  async refreshMomoDeposit(depositId: string): Promise<DepositRecord> {
    const d = await this.prisma.depositRecord.findUnique({
      where: { id: depositId },
    });
    if (!d) throw new NotFoundException('Deposit not found.');
    if (
      d.status !== DepositRecordStatus.PENDING ||
      d.paymentMethod !== DepositPaymentMethod.MTN_MOMO ||
      !d.externalReference
    ) {
      return d;
    }
    let result: MomoStatusResult;
    try {
      result = await this.momo.getRequestToPayStatus(d.externalReference);
    } catch (e) {
      this.logger.warn(
        `MoMo status check failed for ${d.id}: ${e instanceof Error ? e.message : e}`,
      );
      return d;
    }
    if (result.status === 'SUCCESSFUL') {
      await this.settleMomoDeposit(d.id, result);
    } else if (result.status === 'FAILED') {
      await this.failMomoDeposit(
        d.id,
        result.reason ?? 'Payment failed or was declined.',
        result,
      );
    } else {
      const ageMin = (Date.now() - d.createdAt.getTime()) / 60000;
      if (ageMin > this.momo.pendingTimeoutMinutes) {
        await this.failMomoDeposit(
          d.id,
          'The payment prompt expired without approval.',
          result,
        );
      } else {
        await this.prisma.depositRecord.update({
          where: { id: d.id },
          data: {
            providerStatus: 'PENDING',
            providerPayload: result.raw as Prisma.InputJsonValue,
          },
        });
      }
    }
    return this.prisma.depositRecord.findUniqueOrThrow({ where: { id: d.id } });
  }

  /** Callback entry point: never trusts the body, always re-checks with MTN. */
  async handleMomoCollectionCallback(body: {
    externalId?: string;
    referenceId?: string;
  }) {
    const d = await this.prisma.depositRecord.findFirst({
      where: {
        OR: [
          ...(body.externalId ? [{ id: body.externalId }] : []),
          ...(body.referenceId
            ? [{ externalReference: body.referenceId }]
            : []),
        ],
      },
      select: { id: true },
    });
    if (!d) return { ok: false };
    const after = await this.refreshMomoDeposit(d.id);
    return { ok: true, status: after.status };
  }

  private async settleMomoDeposit(depositId: string, result: MomoStatusResult) {
    const now = new Date();
    let settlement: SettlementResult | null = null;
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.depositRecord.updateMany({
        where: { id: depositId, status: DepositRecordStatus.PENDING },
        data: {
          status: DepositRecordStatus.CONFIRMED,
          reviewedAt: now,
          providerStatus: 'SUCCESSFUL',
          providerTransactionId: result.financialTransactionId ?? null,
          providerPayload: result.raw as Prisma.InputJsonValue,
        },
      });
      if (claimed.count === 0) return; // already settled by another worker
      const dep = await tx.depositRecord.findUniqueOrThrow({
        where: { id: depositId },
      });
      settlement = await this.allocation.settleDeposit(tx, dep, now);
    });
    if (settlement)
      await this.afterDepositSettled(depositId, settlement, 'MOMO');
  }

  private async failMomoDeposit(
    depositId: string,
    reason: string,
    result: MomoStatusResult,
  ) {
    const claimed = await this.prisma.depositRecord.updateMany({
      where: { id: depositId, status: DepositRecordStatus.PENDING },
      data: {
        status: DepositRecordStatus.FAILED,
        failureReason: reason,
        providerStatus: 'FAILED',
        providerPayload: result.raw as Prisma.InputJsonValue,
      },
    });
    if (claimed.count === 0) return;
    const d = await this.prisma.depositRecord.findUniqueOrThrow({
      where: { id: depositId },
      include: { group: { select: { name: true } } },
    });
    void this.notifications
      .notifyMember({
        userId: d.userId,
        groupId: d.groupId,
        type: NotificationType.DEPOSIT_FAILED,
        title: 'MoMo payment failed',
        body: `Your ${decN(d.amount).toFixed(0)} ${d.currency} MoMo payment in ${d.group.name} did not go through: ${reason}`,
        metadata: { groupName: d.group.name, depositId: d.id, reason },
      })
      .catch((e) => this.logger.error(e));
  }

  /** Background poller: refresh MoMo deposits still waiting on the payer. */
  async pollPendingMomoDeposits(): Promise<number> {
    const pending = await this.prisma.depositRecord.findMany({
      where: {
        status: DepositRecordStatus.PENDING,
        paymentMethod: DepositPaymentMethod.MTN_MOMO,
        externalReference: { not: null },
        createdAt: { lt: new Date(Date.now() - 15_000) },
      },
      select: { id: true },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });
    for (const p of pending) {
      await this.refreshMomoDeposit(p.id).catch((e) => this.logger.error(e));
    }
    return pending.length;
  }

  /** Member (own deposit) or leader: deposit status + where the money went. */
  async getDepositStatus(userId: string, groupId: string, depositId: string) {
    const { membership } = await this.requireActiveMemberInVerifiedGroup(
      userId,
      groupId,
    );
    let d = await this.prisma.depositRecord.findFirst({
      where: { id: depositId, groupId },
    });
    if (!d) throw new NotFoundException('Deposit not found.');
    const leader =
      membership.role.name === RoleName.GROUP_ADMIN ||
      membership.role.name === RoleName.TREASURER;
    if (d.userId !== userId && !leader) {
      throw new ForbiddenException('You can only view your own payments.');
    }
    if (d.status === DepositRecordStatus.PENDING) {
      d = await this.refreshMomoDeposit(d.id);
    }
    const allocations = await this.prisma.depositAllocation.findMany({
      where: { depositId: d.id },
      orderBy: { createdAt: 'asc' },
      include: {
        contribution: { select: { dueDate: true } },
        fine: { select: { reason: true } },
      },
    });
    return {
      ...this.depositResponse(d, ''),
      paymentMethod: d.paymentMethod,
      createdAt: d.createdAt.toISOString(),
      reviewedAt: d.reviewedAt?.toISOString() ?? null,
      contributionPortion: decN(d.contributionPortion),
      finePortion: decN(d.finePortion),
      installmentPortion: decN(d.installmentPortion),
      providerTransactionId: d.providerTransactionId,
      allocations: allocations.map((a) => ({
        kind: a.kind,
        amount: decN(a.amount),
        contributionId: a.contributionId,
        contributionDueDate: a.contribution?.dueDate.toISOString() ?? null,
        fineId: a.fineId,
        fineReason: a.fine?.reason ?? null,
        memberLoanId: a.memberLoanId,
      })),
    };
  }

  /** Emails + in-app notifications once money has been applied. */
  private async afterDepositSettled(
    depositId: string,
    s: SettlementResult,
    channel: 'MOMO' | 'MANUAL',
  ) {
    const d = await this.prisma.depositRecord.findUnique({
      where: { id: depositId },
      include: {
        user: { select: { fullName: true, email: true } },
        group: { select: { name: true } },
      },
    });
    if (!d) return;
    const amount = decN(d.amount).toFixed(2);
    const isLoan = s.installmentPortion > EPS && s.contributionPortion < EPS;
    try {
      await this.emailService.sendManualDepositConfirmedEmail(d.user.email, {
        memberName: d.user.fullName,
        groupName: d.group.name,
        amount,
        currency: d.currency,
      });
    } catch (e) {
      this.logger.error(
        `Failed to send deposit confirmation email: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const base = {
      userId: d.userId,
      groupId: d.groupId,
      groupName: d.group.name,
      amount,
      currency: d.currency,
    };
    const p =
      channel === 'MANUAL'
        ? this.notifications.notifyMemberManualDepositConfirmed({
            ...base,
            isLoan,
          })
        : isLoan
          ? this.notifications.notifyMemberLoanRepaymentRecorded(base)
          : this.notifications.notifyMemberDepositRecorded(base);
    void p.catch((e) => this.logger.error(e));
  }

  // ── manual review ───────────────────────────────────────────────────────

  async getMyPendingManualDeposits(userId: string, groupId: string) {
    await this.requireActiveMemberInVerifiedGroup(userId, groupId);
    const rows = await this.prisma.depositRecord.findMany({
      where: {
        userId,
        groupId,
        status: {
          in: [
            DepositRecordStatus.PENDING_VERIFICATION,
            DepositRecordStatus.PENDING,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      amount: decN(r.amount),
      currency: r.currency,
      status: r.status,
      paymentMethod: r.paymentMethod,
      purpose: r.purpose,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async listPendingManualDeposits(reviewerId: string, groupId: string) {
    await this.requireGroupAdminOrTreasurerInVerifiedGroup(reviewerId, groupId);
    const rows = await this.prisma.depositRecord.findMany({
      where: {
        groupId,
        status: DepositRecordStatus.PENDING_VERIFICATION,
        paymentMethod: DepositPaymentMethod.MANUAL_TRANSFER,
      },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, fullName: true, email: true } } },
    });
    return rows
      .filter((r) => r.proofImageUrl)
      .map((r) => ({
        id: r.id,
        amount: decN(r.amount),
        currency: r.currency,
        paymentMethod: r.paymentMethod,
        purpose: r.purpose,
        contributionPortion: decN(r.contributionPortion),
        finePortion: decN(r.finePortion),
        installmentPortion: decN(r.installmentPortion),
        proofImageUrl: r.proofImageUrl as string,
        createdAt: r.createdAt.toISOString(),
        /** Reviewers can never confirm or reject their own payment. */
        isOwn: r.userId === reviewerId,
        canReview: r.userId !== reviewerId,
        member: {
          id: r.userId,
          fullName: r.user.fullName,
          email: r.user.email,
        },
      }));
  }

  private async loadReviewableDeposit(
    reviewerId: string,
    groupId: string,
    depositId: string,
  ) {
    const deposit = await this.prisma.depositRecord.findFirst({
      where: { id: depositId, groupId },
      include: { user: { select: { id: true, fullName: true, email: true } } },
    });
    if (!deposit) throw new NotFoundException('Deposit not found.');
    if (deposit.userId === reviewerId) {
      throw new ForbiddenException(
        'You cannot review your own payment. Another group leader must confirm or reject it.',
      );
    }
    if (deposit.status !== DepositRecordStatus.PENDING_VERIFICATION) {
      throw new BadRequestException(
        'This deposit is not awaiting manual proof verification.',
      );
    }
    if (deposit.paymentMethod !== DepositPaymentMethod.MANUAL_TRANSFER) {
      throw new BadRequestException(
        'Only manual bank transfers are reviewed from this list.',
      );
    }
    return deposit;
  }

  async confirmManualDeposit(
    reviewerId: string,
    groupId: string,
    depositId: string,
  ) {
    const { group } = await this.requireGroupAdminOrTreasurerInVerifiedGroup(
      reviewerId,
      groupId,
    );
    const deposit = await this.loadReviewableDeposit(
      reviewerId,
      groupId,
      depositId,
    );
    const reviewer = await this.prisma.user.findUnique({
      where: { id: reviewerId },
      select: { fullName: true },
    });

    const now = new Date();
    let settlement: SettlementResult | null = null;
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.depositRecord.updateMany({
        where: {
          id: depositId,
          groupId,
          status: DepositRecordStatus.PENDING_VERIFICATION,
          userId: { not: reviewerId },
        },
        data: {
          status: DepositRecordStatus.CONFIRMED,
          reviewedAt: now,
          reviewedByUserId: reviewerId,
        },
      });
      if (claimed.count === 0)
        throw new NotFoundException('Deposit not found.');
      const fresh = await tx.depositRecord.findUniqueOrThrow({
        where: { id: depositId },
      });
      settlement = await this.allocation.settleDeposit(tx, fresh, now);
    });
    if (settlement)
      await this.afterDepositSettled(depositId, settlement, 'MANUAL');

    const amountText = decN(deposit.amount).toFixed(2);
    void this.notifications
      .notifyAuditManualConfirm({
        groupId,
        groupName: group.name,
        amount: amountText,
        currency: deposit.currency,
        memberName: deposit.user.fullName,
        excludeUserId: reviewerId,
      })
      .catch((e) => this.logger.error(e));
    const auditTo = await this.getFinanceLeaderEmailsForGroup(
      groupId,
      reviewerId,
    );
    try {
      await this.emailService.sendManualDepositAuditToGroupAdmins(auditTo, {
        groupName: group.name,
        kind: 'CONFIRMED',
        memberName: deposit.user.fullName,
        amount: amountText,
        currency: deposit.currency,
        depositId,
        reason: null,
        reviewerName: reviewer?.fullName ?? 'Group admin',
      });
    } catch (e) {
      this.logger.error(
        `Failed to send group admin audit (confirm): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return {
      id: depositId,
      status: 'CONFIRMED' as const,
      message:
        'Payment confirmed. The member was notified by email and their balance was updated.',
    };
  }

  async rejectManualDeposit(
    reviewerId: string,
    groupId: string,
    depositId: string,
    reason: string | undefined,
  ) {
    const { group } = await this.requireGroupAdminOrTreasurerInVerifiedGroup(
      reviewerId,
      groupId,
    );
    const deposit = await this.loadReviewableDeposit(
      reviewerId,
      groupId,
      depositId,
    );
    const trimmed = reason?.trim() || null;
    const reviewer = await this.prisma.user.findUnique({
      where: { id: reviewerId },
      select: { fullName: true },
    });

    const claimed = await this.prisma.depositRecord.updateMany({
      where: {
        id: depositId,
        status: DepositRecordStatus.PENDING_VERIFICATION,
      },
      data: {
        status: DepositRecordStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedByUserId: reviewerId,
        rejectionReason: trimmed,
      },
    });
    if (claimed.count === 0) throw new NotFoundException('Deposit not found.');

    const amountText = decN(deposit.amount).toFixed(2);
    try {
      await this.emailService.sendManualDepositRejectedEmail(
        deposit.user.email,
        {
          memberName: deposit.user.fullName,
          groupName: group.name,
          amount: amountText,
          currency: deposit.currency,
          reason: trimmed,
        },
      );
    } catch (e) {
      this.logger.error(
        `Failed to send manual deposit rejection email: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    void this.notifications
      .notifyMemberDepositRejected({
        userId: deposit.userId,
        groupId,
        groupName: group.name,
        amount: amountText,
        currency: deposit.currency,
        reason: trimmed,
      })
      .catch((e) => this.logger.error(e));
    void this.notifications
      .notifyAuditManualReject({
        groupId,
        groupName: group.name,
        amount: amountText,
        currency: deposit.currency,
        memberName: deposit.user.fullName,
        excludeUserId: reviewerId,
      })
      .catch((e) => this.logger.error(e));
    const auditTo = await this.getFinanceLeaderEmailsForGroup(
      groupId,
      reviewerId,
    );
    try {
      await this.emailService.sendManualDepositAuditToGroupAdmins(auditTo, {
        groupName: group.name,
        kind: 'REJECTED',
        memberName: deposit.user.fullName,
        amount: amountText,
        currency: deposit.currency,
        depositId,
        reason: trimmed,
        reviewerName: reviewer?.fullName ?? 'Group admin',
      });
    } catch (e) {
      this.logger.error(
        `Failed to send group admin audit (reject): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return {
      id: depositId,
      status: 'REJECTED' as const,
      message: 'Payment rejected. The member was notified by email.',
    };
  }

  // ── loan eligibility ────────────────────────────────────────────────────

  async getLoanRequestPreview(userId: string, groupId: string) {
    await this.requireActiveMemberInVerifiedGroup(userId, groupId);
    const loanConfig = await this.prisma.loanConfig.findUnique({
      where: { groupId },
    });
    if (!loanConfig) {
      return {
        configured: false as const,
        message: 'Loan rules are not configured for this group yet.',
      };
    }

    const [paid, openLoan, writtenOff, lateCount, fines, pendingApp, cashPos] =
      await Promise.all([
        this.prisma.contribution.aggregate({
          where: { userId, groupId },
          _sum: { amountPaid: true },
        }),
        this.prisma.memberLoan.findFirst({
          where: { userId, groupId, status: { in: OPEN_LOAN_STATUSES } },
          select: { id: true },
        }),
        this.prisma.memberLoan.count({
          where: { userId, groupId, status: MemberLoanStatus.WRITTEN_OFF },
        }),
        this.prisma.contribution.count({
          where: { userId, groupId, status: ContributionStatus.LATE },
        }),
        this.prisma.fine.findMany({
          where: { userId, groupId, status: FineStatus.OPEN },
          select: { amount: true, amountPaid: true },
        }),
        this.prisma.loanApplication.findFirst({
          where: { userId, groupId, status: LoanApplicationStatus.PENDING },
          select: { id: true },
        }),
        this.cash.getCashPosition(groupId),
      ]);

    const totalContributed = roundMoney(decN(paid._sum.amountPaid));
    const openFines = roundMoney(
      fines.reduce((s, f) => s + decN(f.amount) - decN(f.amountPaid), 0),
    );
    const allowExceed = loanConfig.allowExceedContribution;
    const mult = loanConfig.maxLoanMultiplier;

    let stakeCap: number;
    if (!allowExceed) stakeCap = totalContributed;
    else if (mult != null) stakeCap = totalContributed * decN(mult);
    else stakeCap = Number.POSITIVE_INFINITY;
    const maxAmount = roundMoney(
      Math.max(0, Math.min(stakeCap, cashPos.available)),
    );

    const blockers: string[] = [];
    if (openLoan) {
      blockers.push(
        'You already have an unpaid loan in this group. Repay it before applying for another loan.',
      );
    }
    if (pendingApp) {
      blockers.push(
        'You already have a loan application waiting for approval.',
      );
    }
    if (writtenOff > 0) {
      blockers.push(
        'A previous loan of yours was written off. Talk to your group leaders.',
      );
    }
    if (loanConfig.blockIfArrears && (lateCount > 0 || openFines > EPS)) {
      const parts: string[] = [];
      if (lateCount > 0)
        parts.push(`${lateCount} late contribution${lateCount > 1 ? 's' : ''}`);
      if (openFines > EPS)
        parts.push(`${openFines.toFixed(0)} RWF in unpaid fines`);
      blockers.push(`Clear your arrears first (${parts.join(' and ')}).`);
    }
    if (cashPos.available < 1) {
      blockers.push('The group has no cash available for loans right now.');
    } else if (stakeCap > cashPos.available) {
      // informative only; maxAmount already capped
    }
    if (blockers.length === 0 && maxAmount <= 0) {
      blockers.push(
        'You are not eligible yet (max amount is 0). Contribute first.',
      );
    }

    return {
      configured: true as const,
      canRequest: blockers.length === 0,
      currency: 'RWF',
      minAmount: 0.01,
      maxAmount,
      totalContributed,
      stakeCap: Number.isFinite(stakeCap) ? roundMoney(stakeCap) : null,
      groupCashAvailable: cashPos.available,
      lateContributions: lateCount,
      openFines,
      interestRate: decN(loanConfig.interestRate),
      repaymentPeriodDays: loanConfig.repaymentPeriodDays,
      allowExceedContribution: allowExceed,
      blockers,
      ...(blockers.length > 0 ? { message: blockers[0] } : {}),
    };
  }

  async createLoanApplication(
    userId: string,
    groupId: string,
    requestedAmount: number,
  ) {
    const { membership } = await this.requireActiveMemberInVerifiedGroup(
      userId,
      groupId,
    );
    const loanConfig = await this.prisma.loanConfig.findUnique({
      where: { groupId },
    });
    if (!loanConfig)
      throw new BadRequestException('Loan is not configured for this group.');

    const preview = await this.getLoanRequestPreview(userId, groupId);
    if (!preview.configured) {
      throw new BadRequestException(
        'You cannot request a loan in this group yet.',
      );
    }
    if (!preview.canRequest) {
      throw new BadRequestException(
        preview.blockers[0] ?? 'You are not eligible to request a loan.',
      );
    }
    if (requestedAmount > preview.maxAmount + 0.01) {
      throw new BadRequestException(
        `Requested amount must not exceed ${preview.maxAmount.toFixed(2)} RWF (your stake and the group's available cash).`,
      );
    }

    const applicantRole = membership.role?.name;
    const now = new Date();
    const created = await this.prisma.loanApplication.create({
      data: {
        userId,
        groupId,
        requestedAmount: dec(requestedAmount),
        status: LoanApplicationStatus.PENDING,
        interestRateSnapshot: loanConfig.interestRate,
        repaymentPeriodDaysSnapshot: loanConfig.repaymentPeriodDays,
        maxAmountSnapshot: dec(preview.maxAmount),
        ...(applicantRole === RoleName.GROUP_ADMIN
          ? { groupAdminApprovedAt: now, groupAdminApprovedById: userId }
          : {}),
        ...(applicantRole === RoleName.TREASURER
          ? { treasurerApprovedAt: now, treasurerApprovedById: userId }
          : {}),
      },
    });

    const g = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { name: true },
    });
    if (g) {
      const member = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true },
      });
      void this.notifications
        .notifyLoanApplicationSubmitted({
          groupId,
          groupName: g.name,
          applicationId: created.id,
          applicantUserId: userId,
          applicantName: member?.fullName ?? 'Member',
          amount: decN(created.requestedAmount).toFixed(0),
        })
        .catch((e) => this.logger.error(e));
    }

    return {
      id: created.id,
      status: created.status,
      requestedAmount: decN(created.requestedAmount),
      message:
        applicantRole === RoleName.GROUP_ADMIN
          ? 'Your loan request was submitted. Group admin approval was auto-recorded, and treasurer approval is still required before disbursement.'
          : applicantRole === RoleName.TREASURER
            ? 'Your loan request was submitted. Treasurer approval was auto-recorded, and group admin approval is still required before disbursement.'
            : 'Your loan request was submitted. Both the group admin and the treasurer must approve before it is disbursed.',
    };
  }

  async getCashPosition(userId: string, groupId: string) {
    await this.requireGroupAdminOrTreasurerInVerifiedGroup(userId, groupId);
    return this.cash.getCashPosition(groupId);
  }
}
