import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  GroupMembershipStatus,
  LoanApplicationStatus,
  LoanDisbursement,
  LoanDisbursementMethod,
  LoanDisbursementStatus,
  MemberLoanStatus,
  NotificationType,
  Prisma,
  RoleName,
} from '@prisma/client';
import { GroupCashService } from '../finance-core/group-cash.service';
import {
  EPS,
  addDays,
  dec,
  decN,
  roundMoney,
} from '../finance-core/money.util';
import {
  OPEN_LOAN_STATUSES,
  PAYABLE_LOAN_STATUSES,
  loanBalances,
} from '../finance-core/payment-allocation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MomoService } from '../payments/momo.service';
import { PrismaService } from '../prisma/prisma.service';

const loanInclude = {
  user: { select: { id: true, fullName: true, email: true } },
  group: { select: { name: true } },
  disbursement: true,
} satisfies Prisma.MemberLoanInclude;

type LoanWithRefs = Prisma.MemberLoanGetPayload<{
  include: typeof loanInclude;
}>;

@Injectable()
export class GroupLoansService {
  private readonly logger = new Logger(GroupLoansService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly cash: GroupCashService,
    private readonly momo: MomoService,
  ) {}

  private async requireVerifiedGroup(groupId: string) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
    });
    if (!group || group.deletedAt)
      throw new NotFoundException(`Group ${groupId} was not found.`);
    if (!group.isVerified) {
      throw new ForbiddenException('This action is only for verified groups.');
    }
    return group;
  }

  private async getActiveMembershipWithRole(userId: string, groupId: string) {
    const m = await this.prisma.userGroup.findFirst({
      where: {
        userId,
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
      },
      include: { role: true },
    });
    if (!m)
      throw new ForbiddenException(
        'You are not an active member of this group.',
      );
    return m;
  }

  /** Group admin or treasurer, for review routes. */
  private async requireAdminOrTreasurer(userId: string, groupId: string) {
    await this.requireVerifiedGroup(groupId);
    const m = await this.getActiveMembershipWithRole(userId, groupId);
    if (
      m.role.name !== RoleName.GROUP_ADMIN &&
      m.role.name !== RoleName.TREASURER
    ) {
      throw new ForbiddenException(
        'Only a group admin or treasurer can manage loans.',
      );
    }
    return m.role.name;
  }

  // ── applications ────────────────────────────────────────────────────────

  async listLoanApplicationsForGroup(reviewerId: string, groupId: string) {
    await this.requireAdminOrTreasurer(reviewerId, groupId);
    const apps = await this.prisma.loanApplication.findMany({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        group: { select: { id: true, name: true } },
        groupAdminApprovedBy: { select: { id: true, fullName: true } },
        treasurerApprovedBy: { select: { id: true, fullName: true } },
        rejectedBy: { select: { id: true, fullName: true } },
        memberLoan: { select: { id: true } },
      },
    });
    return apps.map((a) => this.toApplicationDto(a));
  }

  private toApplicationDto(
    a: Prisma.LoanApplicationGetPayload<{
      include: {
        user: { select: { id: true; fullName: true; email: true } };
        group: { select: { id: true; name: true } };
        groupAdminApprovedBy: { select: { id: true; fullName: true } };
        treasurerApprovedBy: { select: { id: true; fullName: true } };
        rejectedBy: { select: { id: true; fullName: true } };
        memberLoan: { select: { id: true } };
      };
    }>,
  ) {
    const gAdmin = a.groupAdminApprovedAt != null;
    const treas = a.treasurerApprovedAt != null;
    const pending = a.status === LoanApplicationStatus.PENDING;
    const waitingText = pending
      ? !gAdmin && !treas
        ? 'Group admin and treasurer'
        : gAdmin && !treas
          ? 'Treasurer'
          : !gAdmin && treas
            ? 'Group admin'
            : null
      : null;
    return {
      id: a.id,
      userId: a.userId,
      userName: a.user.fullName,
      userEmail: a.user.email,
      groupId: a.groupId,
      groupName: a.group.name,
      requestedAmount: decN(a.requestedAmount),
      currency: 'RWF',
      interestRate: decN(a.interestRateSnapshot),
      repaymentPeriodDays: a.repaymentPeriodDaysSnapshot,
      maxAmountAtRequest:
        a.maxAmountSnapshot != null ? decN(a.maxAmountSnapshot) : null,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
      groupAdminApproved: gAdmin,
      groupAdminApprovedAt: a.groupAdminApprovedAt?.toISOString() ?? null,
      groupAdminApprovedByName: a.groupAdminApprovedBy?.fullName ?? null,
      treasurerApproved: treas,
      treasurerApprovedAt: a.treasurerApprovedAt?.toISOString() ?? null,
      treasurerApprovedByName: a.treasurerApprovedBy?.fullName ?? null,
      waitingOn: waitingText,
      rejectionReason: a.rejectionReason,
      rejectedAt: a.rejectedAt?.toISOString() ?? null,
      memberLoanId: a.memberLoan?.id ?? null,
    };
  }

  /** Phone to pay a loan out to: profile phone, else the member's last MoMo payment number. */
  private async payoutPhone(
    userId: string,
    groupId: string,
  ): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true },
    });
    const candidates = [u?.phoneNumber];
    if (!u?.phoneNumber) {
      const last = await this.prisma.depositRecord.findFirst({
        where: { userId, groupId, phone: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { phone: true },
      });
      candidates.push(last?.phone);
    }
    for (const c of candidates) {
      if (!c) continue;
      try {
        return this.momo.normalizeMsisdn(c);
      } catch {
        /* not a usable MSISDN */
      }
    }
    return null;
  }

  async approveLoanApplication(
    approverId: string,
    groupId: string,
    applicationId: string,
  ) {
    const role = await this.requireAdminOrTreasurer(approverId, groupId);
    const isAdmin = role === RoleName.GROUP_ADMIN;
    const now = new Date();

    const pre = await this.prisma.loanApplication.findFirst({
      where: { id: applicationId, groupId },
      select: { userId: true },
    });
    const momoPhone =
      pre && this.momo.isEnabled('disbursement')
        ? await this.payoutPhone(pre.userId, groupId)
        : null;

    const out = await this.prisma.$transaction(async (tx) => {
      const app = await tx.loanApplication.findFirst({
        where: { id: applicationId, groupId },
      });
      if (!app) throw new NotFoundException('Loan application not found.');
      if (app.status !== LoanApplicationStatus.PENDING) {
        throw new BadRequestException('This application is no longer pending.');
      }
      if (app.userId === approverId) {
        throw new ForbiddenException(
          'You cannot approve your own loan application.',
        );
      }
      if (
        (isAdmin && app.groupAdminApprovedAt) ||
        (!isAdmin && app.treasurerApprovedAt)
      ) {
        return {
          applicationId: app.id,
          status: 'PENDING' as const,
          memberLoanId: null as string | null,
          disbursementId: null as string | null,
          alreadyOnFile: true,
          message: isAdmin
            ? 'Group admin approval was already on file.'
            : 'Treasurer approval was already on file.',
        };
      }

      const after = await tx.loanApplication.update({
        where: { id: applicationId },
        data: isAdmin
          ? { groupAdminApprovedAt: now, groupAdminApprovedById: approverId }
          : { treasurerApprovedAt: now, treasurerApprovedById: approverId },
      });

      if (
        after.groupAdminApprovedAt == null ||
        after.treasurerApprovedAt == null
      ) {
        return {
          applicationId: after.id,
          status: 'PENDING' as const,
          memberLoanId: null,
          disbursementId: null,
          alreadyOnFile: false,
          message: isAdmin
            ? 'Group admin approval recorded. Waiting for treasurer approval before the loan is disbursed.'
            : 'Treasurer approval recorded. Waiting for group admin approval before the loan is disbursed.',
        };
      }

      // Final approval: re-check what may have changed since the request.
      const openLoan = await tx.memberLoan.findFirst({
        where: {
          userId: after.userId,
          groupId,
          status: { in: OPEN_LOAN_STATUSES },
        },
        select: { id: true },
      });
      if (openLoan) {
        throw new BadRequestException(
          'The member already has an unpaid loan in this group.',
        );
      }
      const principal = decN(after.requestedAmount);
      const available = await this.cash.getAvailableCash(groupId, tx);
      if (principal - available > EPS) {
        throw new BadRequestException(
          `The group only has ${available.toFixed(0)} RWF available; this loan needs ${principal.toFixed(0)} RWF.`,
        );
      }

      const totalRep = roundMoney(
        principal * (1 + decN(after.interestRateSnapshot) / 100),
      );
      // Term counts from disbursement (reset again when a MoMo payout completes).
      const due = addDays(now, after.repaymentPeriodDaysSnapshot);
      const loan = await tx.memberLoan.create({
        data: {
          userId: after.userId,
          groupId: after.groupId,
          applicationId: after.id,
          principalAmount: after.requestedAmount,
          totalRepayable: dec(totalRep),
          amountRepaid: dec(0),
          currency: 'RWF',
          interestRateSnapshot: after.interestRateSnapshot,
          repaymentPeriodDaysSnapshot: after.repaymentPeriodDaysSnapshot,
          disbursedAt: now,
          dueDate: due,
          status: MemberLoanStatus.ACTIVE,
        },
      });
      const viaMomo = momoPhone != null;
      const disbursement = await tx.loanDisbursement.create({
        data: {
          memberLoanId: loan.id,
          groupId,
          amount: after.requestedAmount,
          currency: 'RWF',
          method: viaMomo
            ? LoanDisbursementMethod.MTN_MOMO
            : LoanDisbursementMethod.RECORDED,
          status: viaMomo
            ? LoanDisbursementStatus.PENDING
            : LoanDisbursementStatus.COMPLETED,
          phone: momoPhone,
          disbursedById: approverId,
          completedAt: viaMomo ? null : now,
        },
      });
      await tx.loanApplication.update({
        where: { id: applicationId },
        data: { status: LoanApplicationStatus.APPROVED },
      });
      return {
        applicationId: after.id,
        status: 'APPROVED' as const,
        memberLoanId: loan.id,
        disbursementId: disbursement.id,
        alreadyOnFile: false,
        message: viaMomo
          ? 'Both approvals received. The loan is being paid out to the member by MTN MoMo.'
          : 'Both approvals received. The loan is recorded as disbursed; hand the money over and keep the receipt.',
      };
    });

    if (out.alreadyOnFile) return out;

    const app = await this.prisma.loanApplication.findFirst({
      where: { id: out.applicationId, groupId },
      include: {
        user: { select: { fullName: true } },
        group: { select: { name: true } },
      },
    });
    if (
      app &&
      out.status === 'APPROVED' &&
      out.memberLoanId &&
      out.disbursementId
    ) {
      const d = await this.prisma.loanDisbursement.findUniqueOrThrow({
        where: { id: out.disbursementId },
      });
      if (d.method === LoanDisbursementMethod.MTN_MOMO) {
        await this.sendMomoDisbursement(d.id);
      } else {
        this.notifyDisbursed(
          app.userId,
          app.groupId,
          app.group.name,
          decN(app.requestedAmount),
          out.memberLoanId,
        );
      }
    } else if (app && out.status === 'PENDING') {
      void this.notifications
        .notifyLoanAwaitingOtherApprover({
          groupId: app.groupId,
          groupName: app.group.name,
          applicationId: app.id,
          applicantName: app.user.fullName,
          amount: decN(app.requestedAmount).toFixed(0),
          justApprovedRole: isAdmin ? 'GROUP_ADMIN' : 'TREASURER',
        })
        .catch((e) => this.logger.error(e));
    }
    return {
      applicationId: out.applicationId,
      status: out.status,
      memberLoanId: out.memberLoanId,
      message: out.message,
    };
  }

  private notifyDisbursed(
    borrowerUserId: string,
    groupId: string,
    groupName: string,
    amount: number,
    memberLoanId: string,
  ) {
    void this.notifications
      .notifyLoanDisbursed({
        borrowerUserId,
        groupId,
        groupName,
        amount: amount.toFixed(0),
        memberLoanId,
      })
      .catch((e) => this.logger.error(e));
  }

  async rejectLoanApplication(
    reviewerId: string,
    groupId: string,
    applicationId: string,
    reason: string | undefined,
  ) {
    await this.requireAdminOrTreasurer(reviewerId, groupId);
    const r = (reason ?? '').trim();
    if (r.length < 3) {
      throw new BadRequestException(
        'Please provide a rejection reason (at least 3 characters).',
      );
    }
    const app = await this.prisma.loanApplication.findFirst({
      where: { id: applicationId, groupId },
      include: { group: { select: { name: true } } },
    });
    if (!app) throw new NotFoundException('Loan application not found.');
    if (app.status !== LoanApplicationStatus.PENDING) {
      throw new BadRequestException('This application is not pending.');
    }
    if (app.userId === reviewerId) {
      throw new ForbiddenException(
        'You cannot reject your own loan application.',
      );
    }
    await this.prisma.loanApplication.update({
      where: { id: applicationId },
      data: {
        status: LoanApplicationStatus.REJECTED,
        rejectionReason: r,
        rejectedAt: new Date(),
        rejectedBy: { connect: { id: reviewerId } },
      },
    });
    void this.notifications
      .notifyLoanRejected({
        borrowerUserId: app.userId,
        groupId: app.groupId,
        groupName: app.group.name,
        reason: r,
      })
      .catch((e) => this.logger.error(e));
    return {
      applicationId,
      status: 'REJECTED' as const,
      message: 'The loan application was rejected.',
    };
  }

  // ── disbursement ────────────────────────────────────────────────────────

  /** Send (or re-send) a MoMo payout for a PENDING/FAILED MTN_MOMO disbursement. */
  private async sendMomoDisbursement(disbursementId: string) {
    const d = await this.prisma.loanDisbursement.findUniqueOrThrow({
      where: { id: disbursementId },
      include: { group: { select: { name: true } } },
    });
    if (!d.phone)
      throw new BadRequestException('No MoMo number on file for this payout.');
    const reference = randomUUID();
    await this.prisma.loanDisbursement.update({
      where: { id: d.id },
      data: {
        reference,
        status: LoanDisbursementStatus.PENDING,
        failureReason: null,
        providerStatus: 'CREATED',
      },
    });
    try {
      await this.momo.transfer({
        referenceId: reference,
        amount: decN(d.amount),
        externalId: d.id,
        msisdn: d.phone,
        payerMessage: `E-kimina loan from ${d.group.name}`,
        payeeNote: `Loan ${d.memberLoanId}`,
      });
    } catch (e) {
      await this.failDisbursement(
        d.id,
        e instanceof Error ? e.message : String(e),
        null,
      );
      return;
    }
    await this.prisma.loanDisbursement.update({
      where: { id: d.id },
      data: { providerStatus: 'PENDING' },
    });
    if (this.momo.isMock) await this.refreshDisbursement(d.id);
  }

  /** Ask MTN for a pending payout's status; complete or fail it. */
  async refreshDisbursement(disbursementId: string): Promise<LoanDisbursement> {
    const d = await this.prisma.loanDisbursement.findUniqueOrThrow({
      where: { id: disbursementId },
    });
    if (
      d.status !== LoanDisbursementStatus.PENDING ||
      d.method !== LoanDisbursementMethod.MTN_MOMO ||
      !d.reference
    ) {
      return d;
    }
    try {
      const r = await this.momo.getTransferStatus(d.reference);
      if (r.status === 'SUCCESSFUL') {
        await this.completeDisbursement(d.id, {
          providerTransactionId: r.financialTransactionId ?? null,
          providerPayload: r.raw,
        });
      } else if (r.status === 'FAILED') {
        await this.failDisbursement(d.id, r.reason ?? 'Payout failed.', r.raw);
      }
    } catch (e) {
      this.logger.warn(
        `Payout status check failed for ${d.id}: ${e instanceof Error ? e.message : e}`,
      );
    }
    return this.prisma.loanDisbursement.findUniqueOrThrow({
      where: { id: d.id },
    });
  }

  async handleMomoDisbursementCallback(body: {
    externalId?: string;
    referenceId?: string;
  }) {
    const d = await this.prisma.loanDisbursement.findFirst({
      where: {
        OR: [
          ...(body.externalId ? [{ id: body.externalId }] : []),
          ...(body.referenceId ? [{ reference: body.referenceId }] : []),
        ],
      },
      select: { id: true },
    });
    if (!d) return { ok: false };
    const after = await this.refreshDisbursement(d.id);
    return { ok: true, status: after.status };
  }

  async pollPendingDisbursements() {
    const rows = await this.prisma.loanDisbursement.findMany({
      where: {
        status: LoanDisbursementStatus.PENDING,
        method: LoanDisbursementMethod.MTN_MOMO,
        reference: { not: null },
        updatedAt: { lt: new Date(Date.now() - 15_000) },
      },
      select: { id: true },
      take: 50,
    });
    for (const r of rows)
      await this.refreshDisbursement(r.id).catch((e) => this.logger.error(e));
    return rows.length;
  }

  /** Payout done: the loan term restarts from now. */
  private async completeDisbursement(
    disbursementId: string,
    extra: {
      providerTransactionId?: string | null;
      providerPayload?: unknown;
      method?: LoanDisbursementMethod;
      reference?: string | null;
      proofImageUrl?: string | null;
      disbursedById?: string;
    },
  ) {
    const now = new Date();
    const done = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.loanDisbursement.updateMany({
        where: {
          id: disbursementId,
          status: {
            in: [LoanDisbursementStatus.PENDING, LoanDisbursementStatus.FAILED],
          },
        },
        data: {
          status: LoanDisbursementStatus.COMPLETED,
          completedAt: now,
          failureReason: null,
          providerStatus:
            extra.method && extra.method !== LoanDisbursementMethod.MTN_MOMO
              ? null
              : 'SUCCESSFUL',
          ...(extra.providerTransactionId !== undefined
            ? { providerTransactionId: extra.providerTransactionId }
            : {}),
          ...(extra.providerPayload !== undefined
            ? {
                providerPayload: extra.providerPayload as Prisma.InputJsonValue,
              }
            : {}),
          ...(extra.method ? { method: extra.method } : {}),
          ...(extra.reference !== undefined
            ? { reference: extra.reference }
            : {}),
          ...(extra.proofImageUrl !== undefined
            ? { proofImageUrl: extra.proofImageUrl }
            : {}),
          ...(extra.disbursedById
            ? { disbursedById: extra.disbursedById }
            : {}),
        },
      });
      if (claimed.count === 0) return null;
      const d = await tx.loanDisbursement.findUniqueOrThrow({
        where: { id: disbursementId },
        include: { memberLoan: true, group: { select: { name: true } } },
      });
      await tx.memberLoan.update({
        where: { id: d.memberLoanId },
        data: {
          disbursedAt: now,
          dueDate: addDays(now, d.memberLoan.repaymentPeriodDaysSnapshot),
        },
      });
      return d;
    });
    if (done) {
      this.notifyDisbursed(
        done.memberLoan.userId,
        done.groupId,
        done.group.name,
        decN(done.amount),
        done.memberLoanId,
      );
    }
  }

  private async failDisbursement(
    disbursementId: string,
    reason: string,
    payload: unknown,
  ) {
    const d = await this.prisma.loanDisbursement.update({
      where: { id: disbursementId },
      data: {
        status: LoanDisbursementStatus.FAILED,
        failureReason: reason,
        providerStatus: 'FAILED',
        ...(payload != null
          ? { providerPayload: payload as Prisma.InputJsonValue }
          : {}),
      },
      include: {
        group: { select: { name: true } },
        memberLoan: { include: { user: { select: { fullName: true } } } },
      },
    });
    void this.notifications
      .notifyFinanceLeaders({
        groupId: d.groupId,
        type: NotificationType.LOAN_DISBURSEMENT_FAILED,
        title: 'Loan payout failed',
        body: `The MoMo payout of ${decN(d.amount).toFixed(0)} RWF to ${d.memberLoan.user.fullName} failed (${reason}). Retry it or record a cash / bank payout.`,
        metadata: {
          groupName: d.group.name,
          memberLoanId: d.memberLoanId,
          disbursementId: d.id,
        },
      })
      .catch((e) => this.logger.error(e));
  }

  private async loadLoanForLeader(
    reviewerId: string,
    groupId: string,
    memberLoanId: string,
  ) {
    const role = await this.requireAdminOrTreasurer(reviewerId, groupId);
    const loan = await this.prisma.memberLoan.findFirst({
      where: { id: memberLoanId, groupId },
      include: loanInclude,
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    if (loan.userId === reviewerId) {
      throw new ForbiddenException('You cannot manage your own loan.');
    }
    return { loan, role };
  }

  async retryDisbursement(
    reviewerId: string,
    groupId: string,
    memberLoanId: string,
  ) {
    const { loan } = await this.loadLoanForLeader(
      reviewerId,
      groupId,
      memberLoanId,
    );
    const d = loan.disbursement;
    if (!d || d.status !== LoanDisbursementStatus.FAILED) {
      throw new BadRequestException('Only a failed payout can be retried.');
    }
    if (!this.momo.isEnabled('disbursement')) {
      throw new BadRequestException(
        'MTN MoMo payouts are not available. Record a cash or bank payout instead.',
      );
    }
    const phone = d.phone ?? (await this.payoutPhone(loan.userId, groupId));
    if (!phone)
      throw new BadRequestException('The member has no MoMo number on file.');
    await this.prisma.loanDisbursement.update({
      where: { id: d.id },
      data: { method: LoanDisbursementMethod.MTN_MOMO, phone },
    });
    await this.sendMomoDisbursement(d.id);
    const after = await this.prisma.loanDisbursement.findUniqueOrThrow({
      where: { id: d.id },
    });
    return { memberLoanId, disbursement: this.toDisbursementDto(after) };
  }

  async recordManualDisbursement(
    reviewerId: string,
    groupId: string,
    memberLoanId: string,
    dto: {
      method: LoanDisbursementMethod;
      reference?: string;
      proofImageUrl?: string;
    },
  ) {
    const { loan } = await this.loadLoanForLeader(
      reviewerId,
      groupId,
      memberLoanId,
    );
    if (
      dto.method !== LoanDisbursementMethod.CASH &&
      dto.method !== LoanDisbursementMethod.BANK_TRANSFER
    ) {
      throw new BadRequestException(
        'Manual payouts must be CASH or BANK_TRANSFER.',
      );
    }
    const d = loan.disbursement;
    if (d && d.status === LoanDisbursementStatus.COMPLETED) {
      throw new BadRequestException('This loan has already been paid out.');
    }
    if (
      d &&
      d.status === LoanDisbursementStatus.PENDING &&
      d.method === LoanDisbursementMethod.MTN_MOMO
    ) {
      throw new BadRequestException(
        'A MoMo payout is still in progress for this loan.',
      );
    }
    let id = d?.id;
    if (!id) {
      id = (
        await this.prisma.loanDisbursement.create({
          data: {
            memberLoanId,
            groupId,
            amount: loan.principalAmount,
            method: dto.method,
            status: LoanDisbursementStatus.PENDING,
          },
        })
      ).id;
    }
    await this.completeDisbursement(id, {
      method: dto.method,
      reference: dto.reference?.trim() || null,
      proofImageUrl: dto.proofImageUrl?.trim() || null,
      disbursedById: reviewerId,
    });
    const after = await this.prisma.loanDisbursement.findUniqueOrThrow({
      where: { id },
    });
    return { memberLoanId, disbursement: this.toDisbursementDto(after) };
  }

  // ── restructuring ───────────────────────────────────────────────────────

  async writeOffLoan(
    reviewerId: string,
    groupId: string,
    memberLoanId: string,
    reason: string,
  ) {
    const { loan, role } = await this.loadLoanForLeader(
      reviewerId,
      groupId,
      memberLoanId,
    );
    if (role !== RoleName.GROUP_ADMIN) {
      throw new ForbiddenException('Only a group admin can write off a loan.');
    }
    if (!OPEN_LOAN_STATUSES.includes(loan.status)) {
      throw new BadRequestException(
        'Only an active or defaulted loan can be written off.',
      );
    }
    const { outstanding } = loanBalances(loan);
    const updated = await this.prisma.memberLoan.update({
      where: { id: loan.id },
      data: {
        status: MemberLoanStatus.WRITTEN_OFF,
        writtenOffAt: new Date(),
        writtenOffById: reviewerId,
        writeOffReason: reason.trim(),
        writtenOffAmount: dec(outstanding),
      },
      include: loanInclude,
    });
    void this.notifications
      .notifyMember({
        userId: loan.userId,
        groupId,
        type: NotificationType.LOAN_WRITTEN_OFF,
        title: 'Loan written off',
        body: `Your loan in ${loan.group.name} (${outstanding.toFixed(0)} RWF outstanding) was written off by the group admin. Reason: ${reason.trim()}`,
        metadata: { groupName: loan.group.name, memberLoanId: loan.id },
      })
      .catch((e) => this.logger.error(e));
    void this.notifications
      .notifyFinanceLeaders({
        groupId,
        type: NotificationType.LOAN_WRITTEN_OFF,
        title: 'Loan written off',
        body: `${loan.user.fullName}'s loan (${outstanding.toFixed(0)} RWF) was written off in ${loan.group.name}.`,
        metadata: { groupName: loan.group.name, memberLoanId: loan.id },
        excludeUserId: reviewerId,
      })
      .catch((e) => this.logger.error(e));
    return this.toMemberLoanDto(updated);
  }

  async extendLoan(
    reviewerId: string,
    groupId: string,
    memberLoanId: string,
    dto: { newDueDate: string; reason: string },
  ) {
    const { loan } = await this.loadLoanForLeader(
      reviewerId,
      groupId,
      memberLoanId,
    );
    if (!OPEN_LOAN_STATUSES.includes(loan.status)) {
      throw new BadRequestException(
        'Only an active or defaulted loan can be extended.',
      );
    }
    const newDue = new Date(dto.newDueDate);
    if (Number.isNaN(newDue.getTime()))
      throw new BadRequestException('Invalid newDueDate.');
    if (newDue <= loan.dueDate || newDue <= new Date()) {
      throw new BadRequestException(
        'The new due date must be later than the current due date and today.',
      );
    }
    const updated = await this.prisma.memberLoan.update({
      where: { id: loan.id },
      data: {
        originalDueDate: loan.originalDueDate ?? loan.dueDate,
        dueDate: newDue,
        status: MemberLoanStatus.ACTIVE,
        defaultedAt: null,
        // Penalties already charged stay; counting restarts from the new due date.
        penaltyPeriodsApplied: 0,
      },
      include: loanInclude,
    });
    const day = newDue.toISOString().slice(0, 10);
    void this.notifications
      .notifyMember({
        userId: loan.userId,
        groupId,
        type: NotificationType.LOAN_EXTENDED,
        title: 'Loan due date extended',
        body: `Your loan in ${loan.group.name} is now due on ${day}. Reason: ${dto.reason.trim()}`,
        metadata: {
          groupName: loan.group.name,
          memberLoanId: loan.id,
          newDueDate: day,
        },
      })
      .catch((e) => this.logger.error(e));
    return this.toMemberLoanDto(updated);
  }

  // ── member loans list / repayment ───────────────────────────────────────

  async listMemberLoansForGroup(reviewerId: string, groupId: string) {
    await this.requireAdminOrTreasurer(reviewerId, groupId);
    const rows = await this.prisma.memberLoan.findMany({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
      include: loanInclude,
    });
    return rows.map((l) => this.toMemberLoanDto(l));
  }

  private toDisbursementDto(d: LoanDisbursement | null) {
    if (!d) return null;
    return {
      id: d.id,
      method: d.method,
      status: d.status,
      amount: decN(d.amount),
      phone: d.phone,
      reference: d.reference,
      failureReason: d.failureReason,
      completedAt: d.completedAt?.toISOString() ?? null,
    };
  }

  toMemberLoanDto(l: LoanWithRefs) {
    const { penalty, outstanding } = loanBalances(l);
    const now = new Date();
    const open = OPEN_LOAN_STATUSES.includes(l.status);
    return {
      id: l.id,
      userId: l.userId,
      userName: l.user.fullName,
      userEmail: l.user.email,
      groupId: l.groupId,
      groupName: l.group.name,
      principal: decN(l.principalAmount),
      totalRepayable: decN(l.totalRepayable),
      amountRepaid: decN(l.amountRepaid),
      penaltyAccrued: penalty,
      penaltyPeriodsApplied: l.penaltyPeriodsApplied,
      outstanding,
      currency: l.currency,
      interestRate: decN(l.interestRateSnapshot),
      repaymentPeriodDays: l.repaymentPeriodDaysSnapshot,
      disbursedAt: l.disbursedAt.toISOString(),
      dueDate: l.dueDate.toISOString(),
      originalDueDate: l.originalDueDate?.toISOString() ?? null,
      status: l.status,
      isOverdue: open && l.dueDate < now && outstanding > EPS,
      defaultedAt: l.defaultedAt?.toISOString() ?? null,
      writtenOffAt: l.writtenOffAt?.toISOString() ?? null,
      writtenOffAmount:
        l.writtenOffAmount != null ? decN(l.writtenOffAmount) : null,
      writeOffReason: l.writeOffReason,
      disbursement: this.toDisbursementDto(l.disbursement),
    };
  }

  async getLoanRepaymentPreviewForMember(
    userId: string,
    groupId: string,
    memberLoanId: string,
  ) {
    await this.getActiveMembershipWithRole(userId, groupId);
    const loan = await this.prisma.memberLoan.findFirst({
      where: { id: memberLoanId, userId, groupId },
    });
    if (!loan) throw new NotFoundException('Loan not found for this group.');
    if (!PAYABLE_LOAN_STATUSES.includes(loan.status)) {
      return {
        configured: false as const,
        message: 'This loan is already closed; no repayment is due.',
      };
    }
    const { penalty, balance, outstanding } = loanBalances(loan);
    if (outstanding < EPS) {
      return {
        configured: false as const,
        message: 'This loan is already fully repaid.',
      };
    }
    const lc = await this.prisma.loanConfig.findUnique({ where: { groupId } });
    return {
      configured: true as const,
      currency: loan.currency,
      status: loan.status,
      allowPartialPayments: lc?.allowPartialPayments ?? true,
      totalDue: outstanding,
      principalPortion: 0,
      /** Accrued late penalty (paid first). */
      finePortion: penalty,
      /** Remaining principal + interest. */
      installmentPortion: balance,
      total: outstanding,
      dueDate: loan.dueDate.toISOString(),
      isOverdue: loan.dueDate < new Date(),
    };
  }
}
