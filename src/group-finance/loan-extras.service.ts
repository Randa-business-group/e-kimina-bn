import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AllocationKind,
  DepositRecordStatus,
  FundType,
  GroupMembershipStatus,
  GuarantorStatus,
  LoanApplicationStatus,
  MemberLoanStatus,
  NotificationType,
  RoleName,
} from '@prisma/client';
import { renderPdf, type PdfLine } from '../common/pdf/simple-pdf';
import { scheduleSnapshot } from '../finance-core/loan-installments';
import { EPS, dec, decN, roundMoney } from '../finance-core/money.util';
import { loanBalances } from '../finance-core/payment-allocation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { GroupLoansService } from './group-loans.service';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const day = (d: Date | string | null | undefined) =>
  d ? new Date(d).toISOString().slice(0, 10) : '-';

/** msfts §4: guarantors, cancelling an application, loan statement (JSON + PDF). */
@Injectable()
export class LoanExtrasService {
  private readonly logger = new Logger(LoanExtrasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loans: GroupLoansService,
    private readonly notifications: NotificationsService,
  ) {}

  private async membership(userId: string, groupId: string) {
    const m = await this.prisma.userGroup.findFirst({
      where: {
        userId,
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
        group: { deletedAt: null },
      },
      include: { role: true, group: { select: { name: true } } },
    });
    if (!m)
      throw new ForbiddenException(
        'You are not an active member of this group.',
      );
    return {
      groupName: m.group.name,
      isLeader:
        m.role.name === RoleName.GROUP_ADMIN ||
        m.role.name === RoleName.TREASURER,
    };
  }

  // ── cancel own application ──────────────────────────────────────────────

  async cancelApplication(
    userId: string,
    groupId: string,
    applicationId: string,
  ) {
    const { groupName } = await this.membership(userId, groupId);
    const app = await this.prisma.loanApplication.findFirst({
      where: { id: applicationId, groupId },
    });
    if (!app) throw new NotFoundException('Loan application not found.');
    if (app.userId !== userId)
      throw new ForbiddenException('You can only cancel your own application.');
    if (app.status !== LoanApplicationStatus.PENDING) {
      throw new BadRequestException(
        'Only a pending application can be cancelled.',
      );
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.loanApplication.update({
        where: { id: app.id },
        data: { status: LoanApplicationStatus.CANCELLED, cancelledAt: now },
      }),
      this.prisma.loanGuarantor.updateMany({
        where: {
          loanApplicationId: app.id,
          status: { in: [GuarantorStatus.REQUESTED, GuarantorStatus.ACCEPTED] },
        },
        data: { status: GuarantorStatus.RELEASED, releasedAt: now },
      }),
    ]);
    const member = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    });
    void this.notifications
      .notifyFinanceLeaders({
        groupId,
        type: NotificationType.LOAN_APPLICATION_CANCELLED,
        title: 'Loan request withdrawn',
        body: `${member?.fullName ?? 'A member'} withdrew their ${fmt(decN(app.requestedAmount))} RWF loan request in ${groupName}.`,
        metadata: { groupName, applicationId: app.id },
      })
      .catch((e) => this.logger.error(e));
    return { id: app.id, status: LoanApplicationStatus.CANCELLED };
  }

  // ── guarantors ──────────────────────────────────────────────────────────

  /** Guarantees asked of me (and their state). */
  async myGuarantees(userId: string, groupId: string) {
    await this.membership(userId, groupId);
    const rows = await this.prisma.loanGuarantor.findMany({
      where: { groupId, guarantorUserId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        application: { include: { user: { select: { fullName: true } } } },
        memberLoan: true,
      },
    });
    return rows.map((g) => ({
      id: g.id,
      status: g.status,
      amountGuaranteed: decN(g.amountGuaranteed),
      borrowerName: g.application.user.fullName,
      requestedAmount: decN(g.application.requestedAmount),
      purpose: g.application.purpose,
      applicationStatus: g.application.status,
      memberLoanId: g.memberLoanId,
      loanStatus: g.memberLoan?.status ?? null,
      loanOutstanding: g.memberLoan
        ? loanBalances(g.memberLoan).outstanding
        : null,
      calledAmount: g.calledAmount != null ? decN(g.calledAmount) : null,
      paidAmount: decN(g.paidAmount),
      createdAt: g.createdAt.toISOString(),
    }));
  }

  async respond(
    userId: string,
    groupId: string,
    guaranteeId: string,
    accept: boolean,
  ) {
    const { groupName } = await this.membership(userId, groupId);
    const g = await this.prisma.loanGuarantor.findFirst({
      where: { id: guaranteeId, groupId },
      include: { application: true },
    });
    if (!g) throw new NotFoundException('Guarantee request not found.');
    if (g.guarantorUserId !== userId)
      throw new ForbiddenException('This request is for another member.');
    if (g.status !== GuarantorStatus.REQUESTED)
      throw new BadRequestException('You already answered this request.');
    if (g.application.status !== LoanApplicationStatus.PENDING) {
      throw new BadRequestException(
        'This loan application is no longer pending.',
      );
    }
    if (accept) {
      // Re-check capacity: savings − other guarantees still locked.
      const [saved, others] = await Promise.all([
        this.prisma.contribution.aggregate({
          where: { userId, groupId, fund: FundType.SAVINGS },
          _sum: { amountPaid: true },
        }),
        this.prisma.loanGuarantor.findMany({
          where: {
            groupId,
            guarantorUserId: userId,
            id: { not: g.id },
            status: {
              in: [
                GuarantorStatus.REQUESTED,
                GuarantorStatus.ACCEPTED,
                GuarantorStatus.CALLED,
              ],
            },
          },
        }),
      ]);
      const locked = others.reduce(
        (a, o) =>
          a +
          (o.status === GuarantorStatus.CALLED
            ? Math.max(0, decN(o.calledAmount) - decN(o.paidAmount))
            : decN(o.amountGuaranteed)),
        0,
      );
      if (
        decN(g.amountGuaranteed) - (decN(saved._sum.amountPaid) - locked) >
        EPS
      ) {
        throw new BadRequestException(
          'Your savings no longer cover this guarantee.',
        );
      }
    }
    await this.prisma.loanGuarantor.update({
      where: { id: g.id },
      data: {
        status: accept ? GuarantorStatus.ACCEPTED : GuarantorStatus.DECLINED,
        respondedAt: new Date(),
      },
    });
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    });
    void this.notifications
      .notifyMember({
        userId: g.application.userId,
        groupId,
        type: NotificationType.GUARANTOR_RESPONDED,
        title: accept ? 'Guarantee accepted' : 'Guarantee declined',
        body: `${me?.fullName ?? 'Your guarantor'} ${accept ? 'accepted' : 'declined'} to guarantee ${fmt(decN(g.amountGuaranteed))} RWF of your loan request in ${groupName}.`,
        metadata: { groupName, applicationId: g.loanApplicationId },
      })
      .catch((e) => this.logger.error(e));
    let memberLoanId: string | null = null;
    if (accept)
      memberLoanId = await this.loans.finalizeIfReady(
        groupId,
        g.loanApplicationId,
      );
    return {
      id: g.id,
      status: accept ? GuarantorStatus.ACCEPTED : GuarantorStatus.DECLINED,
      loanDisbursed: memberLoanId != null,
    };
  }

  /** Leaders: a defaulted / written-off loan — guarantors owe their share of what is left. */
  async callGuarantees(userId: string, groupId: string, memberLoanId: string) {
    const { groupName, isLeader } = await this.membership(userId, groupId);
    if (!isLeader)
      throw new ForbiddenException(
        'Only a group admin or treasurer can call guarantees.',
      );
    const loan = await this.prisma.memberLoan.findFirst({
      where: { id: memberLoanId, groupId },
      include: { user: { select: { fullName: true } } },
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    if (loan.userId === userId)
      throw new ForbiddenException(
        'You cannot call guarantees on your own loan.',
      );
    if (
      loan.status !== MemberLoanStatus.DEFAULTED &&
      loan.status !== MemberLoanStatus.WRITTEN_OFF
    ) {
      throw new BadRequestException(
        'Guarantees can be called once a loan is defaulted or written off.',
      );
    }
    const gs = await this.prisma.loanGuarantor.findMany({
      where: { memberLoanId, status: GuarantorStatus.ACCEPTED },
    });
    if (gs.length === 0)
      throw new BadRequestException('This loan has no accepted guarantors.');
    const outstanding = loanBalances(loan).outstanding;
    const totalGuaranteed = gs.reduce(
      (a, g) => a + decN(g.amountGuaranteed),
      0,
    );
    const now = new Date();
    const out: { guarantorUserId: string; calledAmount: number }[] = [];
    for (const g of gs) {
      const share = roundMoney(
        Math.min(
          decN(g.amountGuaranteed),
          (outstanding * decN(g.amountGuaranteed)) / totalGuaranteed,
        ),
      );
      await this.prisma.loanGuarantor.update({
        where: { id: g.id },
        data: {
          status: GuarantorStatus.CALLED,
          calledAmount: dec(share),
          calledAt: now,
        },
      });
      out.push({ guarantorUserId: g.guarantorUserId, calledAmount: share });
      void this.notifications
        .notifyMember({
          userId: g.guarantorUserId,
          groupId,
          type: NotificationType.GUARANTEE_CALLED,
          title: 'Your guarantee was called',
          body: `${loan.user.fullName}'s loan in ${groupName} is in default. As guarantor you owe ${fmt(share)} RWF; pay it from the loan repayment screen.`,
          metadata: { groupName, memberLoanId },
        })
        .catch((e) => this.logger.error(e));
    }
    return { memberLoanId, outstanding, called: out };
  }

  // ── statement ───────────────────────────────────────────────────────────

  async statement(userId: string, groupId: string, memberLoanId: string) {
    const { groupName, isLeader } = await this.membership(userId, groupId);
    const loan = await this.prisma.memberLoan.findFirst({
      where: { id: memberLoanId, groupId },
      include: {
        user: { select: { fullName: true, email: true, phoneNumber: true } },
        application: true,
        disbursement: true,
        guarantors: true,
      },
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    if (loan.userId !== userId && !isLeader)
      throw new ForbiddenException('You can only view your own loans.');
    const cfg = await this.prisma.loanConfig.findUnique({ where: { groupId } });
    const snap = await scheduleSnapshot(
      this.prisma,
      loan,
      new Date(),
      cfg?.earlyRepaymentRebatePercent ?? 0,
    );
    const allocations = await this.prisma.depositAllocation.findMany({
      where: {
        memberLoanId,
        deposit: { status: DepositRecordStatus.CONFIRMED },
      },
      include: {
        deposit: {
          select: {
            reviewedAt: true,
            createdAt: true,
            paymentMethod: true,
            userId: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const guarantorUsers = await this.prisma.user.findMany({
      where: { id: { in: loan.guarantors.map((g) => g.guarantorUserId) } },
      select: { id: true, fullName: true },
    });
    const gName = new Map(guarantorUsers.map((u) => [u.id, u.fullName]));
    const balances = loanBalances(loan);
    return {
      group: groupName,
      borrower: {
        name: loan.user.fullName,
        email: loan.user.email,
        phone: loan.user.phoneNumber,
      },
      loan: {
        id: loan.id,
        status: loan.status,
        purpose: loan.application.purpose,
        principal: decN(loan.principalAmount),
        interestRate: decN(loan.interestRateSnapshot),
        interestMethod: loan.interestMethodSnapshot,
        installmentInterval: loan.installmentIntervalSnapshot,
        termDays: loan.repaymentPeriodDaysSnapshot,
        totalRepayable: decN(loan.totalRepayable),
        amountRepaid: decN(loan.amountRepaid),
        penaltyAccrued: balances.penalty,
        rebateGranted: decN(loan.rebateGranted),
        outstanding: balances.outstanding,
        disbursedAt: loan.disbursedAt.toISOString(),
        dueDate: loan.dueDate.toISOString(),
        topUpOfLoanId: loan.topUpOfLoanId,
        refinancedByLoanId: loan.refinancedByLoanId,
      },
      disbursement: loan.disbursement
        ? {
            method: loan.disbursement.method,
            status: loan.disbursement.status,
            amount: decN(loan.disbursement.amount),
            reference: loan.disbursement.reference,
            completedAt: loan.disbursement.completedAt?.toISOString() ?? null,
          }
        : null,
      schedule: snap.installments,
      overdueAmount: snap.overdueAmount,
      dueNow: snap.dueNow,
      nextInstallment: snap.nextInstallment,
      earlyPayoff: snap.earlyPayoff,
      payments: allocations.map((a) => ({
        date: (a.deposit.reviewedAt ?? a.deposit.createdAt).toISOString(),
        kind: a.kind === AllocationKind.LOAN_PENALTY ? 'PENALTY' : 'REPAYMENT',
        amount: decN(a.amount),
        method: a.deposit.paymentMethod,
        byGuarantor: a.deposit.userId !== loan.userId,
      })),
      guarantors: loan.guarantors.map((g) => ({
        name: gName.get(g.guarantorUserId) ?? null,
        amountGuaranteed: decN(g.amountGuaranteed),
        status: g.status,
        calledAmount: g.calledAmount != null ? decN(g.calledAmount) : null,
        paidAmount: decN(g.paidAmount),
      })),
    };
  }

  async statementPdf(
    userId: string,
    groupId: string,
    memberLoanId: string,
  ): Promise<Buffer> {
    const s = await this.statement(userId, groupId, memberLoanId);
    const L = s.loan;
    const lines: PdfLine[] = [
      { text: 'Loan statement', size: 18, bold: true },
      { text: `${s.group} - generated ${day(new Date())}`, size: 9 },
      { text: 'Borrower', bold: true, gap: 10 },
      {
        text: `${s.borrower.name}  ${s.borrower.email}${s.borrower.phone ? '  ' + s.borrower.phone : ''}`,
      },
      { text: 'Loan', bold: true, gap: 8 },
      { text: `Status: ${L.status}    Purpose: ${L.purpose ?? '-'}` },
      {
        text: `Principal: ${fmt(L.principal)} RWF    Interest: ${L.interestRate}% ${L.interestMethod.toLowerCase()} over ${L.termDays} days`,
      },
      {
        text: `Disbursed: ${day(L.disbursedAt)}    Final due date: ${day(L.dueDate)}    Repayment: ${L.installmentInterval.toLowerCase()}`,
      },
      {
        text: `Total repayable: ${fmt(L.totalRepayable)} RWF    Repaid: ${fmt(L.amountRepaid)} RWF    Penalty: ${fmt(L.penaltyAccrued)} RWF${L.rebateGranted > 0 ? `    Rebate: ${fmt(L.rebateGranted)} RWF` : ''}`,
      },
      {
        text: `Outstanding: ${fmt(L.outstanding)} RWF    Due now: ${fmt(s.dueNow)} RWF`,
        bold: true,
      },
    ];
    if (s.disbursement) {
      lines.push({
        text: `Payout: ${s.disbursement.method} ${fmt(s.disbursement.amount)} RWF, ${s.disbursement.status.toLowerCase()} ${day(s.disbursement.completedAt)}${s.disbursement.reference ? ', ref ' + s.disbursement.reference : ''}`,
      });
    }
    lines.push({ text: 'Repayment schedule', bold: true, gap: 10 });
    lines.push({
      text: '#',
      bold: true,
      size: 9,
      columns: [
        [80, 'Due date'],
        [170, 'Principal'],
        [250, 'Interest'],
        [330, 'Amount'],
        [410, 'Paid'],
        [480, 'Status'],
      ],
    });
    for (const i of s.schedule) {
      lines.push({
        text: String(i.number),
        size: 9,
        columns: [
          [80, day(i.dueDate)],
          [170, fmt(i.principal)],
          [250, fmt(i.interest)],
          [330, fmt(i.amount)],
          [410, fmt(i.amountPaid)],
          [480, i.status],
        ],
      });
    }
    lines.push({ text: 'Payments', bold: true, gap: 10 });
    if (s.payments.length === 0)
      lines.push({ text: 'No payments yet.', size: 9 });
    for (const p of s.payments) {
      lines.push({
        text: day(p.date),
        size: 9,
        columns: [
          [120, p.kind.toLowerCase()],
          [220, `${fmt(p.amount)} RWF`],
          [320, p.method],
          [430, p.byGuarantor ? 'by guarantor' : ''],
        ],
      });
    }
    if (s.guarantors.length) {
      lines.push({ text: 'Guarantors', bold: true, gap: 10 });
      for (const g of s.guarantors) {
        lines.push({
          text: g.name ?? '-',
          size: 9,
          columns: [
            [220, `${fmt(g.amountGuaranteed)} RWF`],
            [320, g.status],
            [
              430,
              g.calledAmount != null
                ? `called ${fmt(g.calledAmount)}, paid ${fmt(g.paidAmount)}`
                : '',
            ],
          ],
        });
      }
    }
    return renderPdf(lines, `E-kimina loan statement ${L.id}`);
  }
}
