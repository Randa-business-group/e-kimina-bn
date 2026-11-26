import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AllocationKind,
  ContributionStatus,
  DepositPurpose,
  DepositRecord,
  FineStatus,
  MemberLoan,
  MemberLoanStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ContributionScheduleService } from './contribution-schedule.service';
import { EPS, dec, decN, roundMoney } from './money.util';

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
    return { fines: fineItems, rows: rowItems, fineTotal, contributionTotal };
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
    >,
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
      );
    };

    switch (deposit.purpose) {
      case DepositPurpose.LOAN_REPAYMENT:
        await payLoan(deposit.memberLoanId);
        remaining = await this.payContributionSide(
          tx,
          groupId,
          userId,
          remaining,
          lines,
          now,
          true,
        );
        break;
      case DepositPurpose.COMBINED:
        remaining = await this.payContributionSide(
          tx,
          groupId,
          userId,
          remaining,
          lines,
          now,
          false,
        );
        await payLoan(deposit.memberLoanId);
        remaining = await this.payContributionSide(
          tx,
          groupId,
          userId,
          remaining,
          lines,
          now,
          true,
        );
        break;
      case DepositPurpose.CONTRIBUTION:
      default:
        remaining = await this.payContributionSide(
          tx,
          groupId,
          userId,
          remaining,
          lines,
          now,
          true,
        );
        break;
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

    for (const { fine, remaining: due } of open.fines) {
      if (remaining < EPS) break;
      const pay = roundMoney(Math.min(remaining, due));
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
      remaining = roundMoney(remaining - pay);
    }

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

  private async payLoan(
    tx: Db,
    loanId: string,
    userId: string,
    groupId: string,
    amount: number,
    lines: AllocationLine[],
    loansRepaid: string[],
  ): Promise<number> {
    let remaining = roundMoney(amount);
    const loan = await tx.memberLoan.findFirst({
      where: { id: loanId, userId, groupId },
    });
    if (!loan || !PAYABLE_LOAN_STATUSES.includes(loan.status)) return remaining;

    const { penalty, balance } = loanBalances(loan);
    const toPenalty = roundMoney(Math.min(remaining, penalty));
    remaining = roundMoney(remaining - toPenalty);
    const toBalance = roundMoney(Math.min(remaining, balance));
    remaining = roundMoney(remaining - toBalance);
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
    const newPenalty = roundMoney(penalty - toPenalty);
    const newRepaid = roundMoney(decN(loan.amountRepaid) + toBalance);
    const cleared =
      newPenalty + Math.max(0, decN(loan.totalRepayable) - newRepaid) < EPS;
    await tx.memberLoan.update({
      where: { id: loan.id },
      data: {
        penaltyAccrued: dec(newPenalty),
        amountRepaid: dec(newRepaid),
        ...(cleared ? { status: MemberLoanStatus.REPAID } : {}),
      },
    });
    if (cleared) loansRepaid.push(loan.id);
    return remaining;
  }
}
