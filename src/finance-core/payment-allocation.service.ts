import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AllocationKind,
  ContributionStatus,
  DepositRecord,
  FineStatus,
  FundType,
  GuarantorStatus,
  MemberLoan,
  MemberLoanStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ContributionScheduleService } from './contribution-schedule.service';
import { ledgerEntriesForDeposit, writeLedger } from './ledger';
import {
  applyToInstallments,
  markAllInstallmentsPaid,
  scheduleSnapshot,
} from './loan-installments';
import { EPS, dec, decN, roundMoney } from './money.util';
import {
  allocateInOrder,
  allocationSteps,
  splitLoanPayment,
} from './allocation-plan';

type Db = Prisma.TransactionClient;

export interface AllocationLine {
  kind: AllocationKind;
  amount: number;
  contributionId?: string;
  fineId?: string;
  memberLoanId?: string;
}

export interface SettlementResult {
  lines: AllocationLine[];
  contributionPortion: number;
  finePortion: number;
  installmentPortion: number;
  /** Loan ids that became REPAID through this deposit. */
  loansRepaid: string[];
}

/** Loans a member can still pay into. */
export const PAYABLE_LOAN_STATUSES: MemberLoanStatus[] = [
  MemberLoanStatus.ACTIVE,
  MemberLoanStatus.DEFAULTED,
  MemberLoanStatus.WRITTEN_OFF,
];

/** Loans that block a new application. */
export const OPEN_LOAN_STATUSES: MemberLoanStatus[] = [
  MemberLoanStatus.ACTIVE,
  MemberLoanStatus.DEFAULTED,
];

export function loanBalances(
  loan: Pick<MemberLoan, 'totalRepayable' | 'amountRepaid' | 'penaltyAccrued'>,
) {
  const penalty = roundMoney(decN(loan.penaltyAccrued));
  const balance = roundMoney(
    Math.max(0, decN(loan.totalRepayable) - decN(loan.amountRepaid)),
  );
  return { penalty, balance, outstanding: roundMoney(penalty + balance) };
}

/**
 * Applies confirmed money to what a member owes and records every franc in
 * `DepositAllocation`:
 *  - contribution side: open fines (oldest first), then open contribution rows (oldest first);
 *    leftovers pay future periods in advance (rows are created on demand);
 *  - loan side: accrued penalty first, then principal + interest.
 * Partial amounts are always allocated (no money is ever dropped).
 */
@Injectable()
export class PaymentAllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly schedule: ContributionScheduleService,
  ) {}

  /** What the member owes on the contribution side right now. */
  async getOpenObligations(
    groupId: string,
    userId: string,
    db: Db = this.prisma,
  ) {
    const [fines, rows] = await Promise.all([
      db.fine.findMany({
        where: { groupId, userId, status: FineStatus.OPEN },
        orderBy: { createdAt: 'asc' },
      }),
      db.contribution.findMany({
        where: {
          groupId,
          userId,
          status: { in: ContributionScheduleService.OPEN_STATUSES },
        },
        orderBy: { dueDate: 'asc' },
      }),
    ]);
    const fineItems = fines
      .map((f) => ({
        fine: f,
        remaining: roundMoney(decN(f.amount) - decN(f.amountPaid)),
      }))
      .filter((x) => x.remaining > EPS);
    const rowItems = rows
      .map((r) => ({
        row: r,
        remaining: roundMoney(decN(r.amount) - decN(r.amountPaid)),
      }))
      .filter((x) => x.remaining > EPS);
    const fineTotal = roundMoney(
      fineItems.reduce((s, x) => s + x.remaining, 0),
    );
    const contributionTotal = roundMoney(
      rowItems.reduce((s, x) => s + x.remaining, 0),
    );
    /** Part of contributionTotal that feeds the social fund. */
    const socialTotal = roundMoney(
      rowItems
        .filter((x) => x.row.fund === FundType.SOCIAL)
        .reduce((s, x) => s + x.remaining, 0),
    );
    return {
      fines: fineItems,
      rows: rowItems,
      fineTotal,
      contributionTotal,
      savingsTotal: roundMoney(contributionTotal - socialTotal),
      socialTotal,
    };
  }

  /** Member's loan that can receive repayments (most recent first). */
  async getPayableLoan(groupId: string, userId: string, db: Db = this.prisma) {
    const loans = await db.memberLoan.findMany({
      where: { groupId, userId, status: { in: PAYABLE_LOAN_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    return loans.find((l) => loanBalances(l).outstanding > EPS) ?? null;
  }

  /** Apply a confirmed deposit. Must run inside the transaction that confirms it. */
  async settleDeposit(
    tx: Db,
    deposit: Pick<
      DepositRecord,
      'id' | 'userId' | 'groupId' | 'amount' | 'purpose' | 'memberLoanId'
    > & { earlyPayoff?: boolean },
    now = new Date(),
  ): Promise<SettlementResult> {
    const lines: AllocationLine[] = [];
    const loansRepaid: string[] = [];
    let remaining = roundMoney(decN(deposit.amount));
    const { userId, groupId } = deposit;

    const payLoan = async (loanId: string | null) => {
      if (!loanId || remaining < EPS) return;
      remaining = await this.payLoan(
        tx,
        loanId,
        userId,
        groupId,
        remaining,
        lines,
        loansRepaid,
        now,
        deposit.earlyPayoff === true,
      );
    };

    for (const step of allocationSteps(deposit.purpose)) {
      if (step === 'loan') await payLoan(deposit.memberLoanId);
      else {
        remaining = await this.payContributionSide(
          tx,
          groupId,
          userId,
          remaining,
          lines,
          now,
          step === 'advance',
        );
      }
    }

    if (remaining > EPS) {
      throw new BadRequestException(
        `Could not allocate ${remaining.toFixed(2)} of this payment (no contribution rules or open balance).`,
      );
    }

    if (lines.length > 0) {
      await tx.depositAllocation.createMany({
        data: lines.map((l) => ({
          depositId: deposit.id,
          kind: l.kind,
          amount: dec(l.amount),
          contributionId: l.contributionId ?? null,
          fineId: l.fineId ?? null,
          memberLoanId: l.memberLoanId ?? null,
        })),
      });
    }

    const sum = (kinds: AllocationKind[]) =>
      roundMoney(
        lines
          .filter((l) => kinds.includes(l.kind))
          .reduce((s, l) => s + l.amount, 0),
      );
    const result: SettlementResult = {
      lines,
      contributionPortion: sum([AllocationKind.CONTRIBUTION]),
      finePortion: sum([AllocationKind.FINE, AllocationKind.LOAN_PENALTY]),
      installmentPortion: sum([AllocationKind.LOAN_REPAYMENT]),
      loansRepaid,
    };

    await tx.depositRecord.update({
      where: { id: deposit.id },
      data: {
        contributionPortion: dec(result.contributionPortion),
        finePortion: dec(result.finePortion),
        installmentPortion: dec(result.installmentPortion),
      },
    });

    // Cash book: one ledger line per allocation (loan repayments split principal / interest).
    const confirmed = await tx.depositRecord.findUniqueOrThrow({
      where: { id: deposit.id },
    });
    await writeLedger(tx, await ledgerEntriesForDeposit(tx, confirmed));
    return result;
  }

  private async payContributionSide(
    tx: Db,
    groupId: string,
    userId: string,
    amount: number,
    lines: AllocationLine[],
    now: Date,
    advance: boolean,
  ): Promise<number> {
    let remaining = roundMoney(amount);
    if (remaining < EPS) return 0;
    const open = await this.getOpenObligations(groupId, userId, tx);

    const finePlan = allocateInOrder(
      remaining,
      open.fines.map((f) => ({ id: f.fine.id, remaining: f.remaining })),
    );
    for (const { id, pay } of finePlan.pays) {
      const fine = open.fines.find((f) => f.fine.id === id)!.fine;
      const newPaid = roundMoney(decN(fine.amountPaid) + pay);
      const full = newPaid >= decN(fine.amount) - EPS;
      await tx.fine.update({
        where: { id: fine.id },
        data: {
          amountPaid: dec(newPaid),
          ...(full ? { status: FineStatus.PAID, paidAt: now } : {}),
        },
      });
      lines.push({ kind: AllocationKind.FINE, amount: pay, fineId: fine.id });
    }
    remaining = finePlan.left;

    const payRow = async (row: {
      id: string;
      amount: Prisma.Decimal;
      amountPaid: Prisma.Decimal;
      status: ContributionStatus;
    }) => {
      const due = roundMoney(decN(row.amount) - decN(row.amountPaid));
      const pay = roundMoney(Math.min(remaining, due));
      if (pay < EPS) return;
      const newPaid = roundMoney(decN(row.amountPaid) + pay);
      const full = newPaid >= decN(row.amount) - EPS;
      const status = full
        ? ContributionStatus.PAID
        : row.status === ContributionStatus.LATE
          ? ContributionStatus.LATE
          : ContributionStatus.PARTIALLY_PAID;
      await tx.contribution.update({
        where: { id: row.id },
        data: {
          amountPaid: dec(newPaid),
          status,
          ...(full ? { paidAt: now } : {}),
        },
      });
      lines.push({
        kind: AllocationKind.CONTRIBUTION,
        amount: pay,
        contributionId: row.id,
      });
      remaining = roundMoney(remaining - pay);
    };

    for (const { row } of open.rows) {
      if (remaining < EPS) break;
      await payRow(row);
    }

    // Pay ahead: create the next period(s) on demand.
    for (let i = 0; advance && remaining > EPS && i < 520; i++) {
      const row = await this.schedule.createNextPeriodRow(tx, groupId, userId);
      if (!row) break;
      await payRow(row);
    }
    return remaining;
  }

  /**
   * Pay into a loan: penalty first, then the balance (spread over installments oldest first).
   * The payer is the borrower, or a guarantor whose guarantee was CALLED. With `earlyPayoff`,
   * the early-repayment rebate is granted when the payment clears the loan.
   */
  private async payLoan(
    tx: Db,
    loanId: string,
    payerId: string,
    groupId: string,
    amount: number,
    lines: AllocationLine[],
    loansRepaid: string[],
    now: Date,
    earlyPayoff: boolean,
  ): Promise<number> {
    let remaining = roundMoney(amount);
    const loan = await tx.memberLoan.findFirst({
      where: { id: loanId, groupId },
    });
    if (!loan || !PAYABLE_LOAN_STATUSES.includes(loan.status)) return remaining;
    let guarantee: { id: string; paidAmount: Prisma.Decimal } | null = null;
    if (loan.userId !== payerId) {
      guarantee = await tx.loanGuarantor.findFirst({
        where: {
          memberLoanId: loan.id,
          guarantorUserId: payerId,
          status: GuarantorStatus.CALLED,
        },
        select: { id: true, paidAmount: true },
      });
      if (!guarantee) return remaining;
    }

    let { penalty, balance } = loanBalances(loan);
    let rebate = 0;
    if (earlyPayoff && !guarantee) {
      const cfg = await tx.loanConfig.findUnique({
        where: { groupId },
        select: { earlyRepaymentRebatePercent: true },
      });
      const snap = await scheduleSnapshot(
        tx,
        loan,
        now,
        cfg?.earlyRepaymentRebatePercent ?? 0,
      );
      if (snap.earlyPayoff && remaining >= snap.earlyPayoff.amount - EPS) {
        rebate = snap.earlyPayoff.rebate;
        balance = roundMoney(balance - rebate);
      }
    }

    const split = splitLoanPayment(remaining, penalty, balance);
    const { toPenalty, toBalance } = split;
    remaining = split.left;
    if (toPenalty < EPS && toBalance < EPS) return remaining;

    if (toPenalty > EPS) {
      lines.push({
        kind: AllocationKind.LOAN_PENALTY,
        amount: toPenalty,
        memberLoanId: loan.id,
      });
    }
    if (toBalance > EPS) {
      lines.push({
        kind: AllocationKind.LOAN_REPAYMENT,
        amount: toBalance,
        memberLoanId: loan.id,
      });
    }
    penalty = roundMoney(penalty - toPenalty);
    const totalRepayable = roundMoney(decN(loan.totalRepayable) - rebate);
    const newRepaid = roundMoney(decN(loan.amountRepaid) + toBalance);
    const cleared = penalty + Math.max(0, totalRepayable - newRepaid) < EPS;
    await tx.memberLoan.update({
      where: { id: loan.id },
      data: {
        penaltyAccrued: dec(penalty),
        amountRepaid: dec(newRepaid),
        ...(rebate > EPS
          ? { totalRepayable: dec(totalRepayable), rebateGranted: dec(rebate) }
          : {}),
        ...(cleared ? { status: MemberLoanStatus.REPAID } : {}),
      },
    });
    if (cleared) {
      await markAllInstallmentsPaid(tx, loan.id, now);
      await tx.loanGuarantor.updateMany({
        where: {
          memberLoanId: loan.id,
          status: { in: [GuarantorStatus.ACCEPTED, GuarantorStatus.CALLED] },
        },
        data: { status: GuarantorStatus.RELEASED, releasedAt: now },
      });
      loansRepaid.push(loan.id);
    } else {
      await applyToInstallments(tx, loan.id, toBalance, now);
    }
    if (guarantee) {
      await tx.loanGuarantor.update({
        where: { id: guarantee.id },
        data: {
          paidAmount: dec(decN(guarantee.paidAmount) + toPenalty + toBalance),
        },
      });
    }
    return remaining;
  }
}
