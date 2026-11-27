import { DepositPurpose } from '@prisma/client';
import { EPS, roundMoney } from './money.util';

/**
 * Pure allocation rules (msfts §10 — unit-testable without a database). The allocation
 * service applies these plans and records every franc in `DepositAllocation`.
 */

/** Pay items in the given order (oldest first), each up to what is left on it. */
export function allocateInOrder<T extends { id: string; remaining: number }>(
  amount: number,
  items: readonly T[],
) {
  let left = roundMoney(amount);
  const pays: { id: string; pay: number; full: boolean }[] = [];
  for (const it of items) {
    if (left < EPS) break;
    const due = roundMoney(it.remaining);
    if (due < EPS) continue;
    const pay = roundMoney(Math.min(left, due));
    pays.push({ id: it.id, pay, full: pay >= due - EPS });
    left = roundMoney(left - pay);
  }
  return { pays, left };
}

/** A loan payment covers the accrued penalty first, then principal + interest. */
export function splitLoanPayment(
  amount: number,
  penalty: number,
  balance: number,
) {
  const toPenalty = roundMoney(
    Math.min(Math.max(0, amount), Math.max(0, penalty)),
  );
  const afterPenalty = roundMoney(amount - toPenalty);
  const toBalance = roundMoney(
    Math.min(Math.max(0, afterPenalty), Math.max(0, balance)),
  );
  return { toPenalty, toBalance, left: roundMoney(afterPenalty - toBalance) };
}

export type AllocationStep = 'contribution' | 'loan' | 'advance';

/**
 * Order in which a deposit is spent:
 *  - CONTRIBUTION: fines + open periods, then future periods in advance;
 *  - LOAN_REPAYMENT: the loan first, any rest to the contribution side (incl. advance);
 *  - COMBINED: fines + open periods, then the loan, then advance periods.
 */
export function allocationSteps(purpose: DepositPurpose): AllocationStep[] {
  switch (purpose) {
    case DepositPurpose.LOAN_REPAYMENT:
      return ['loan', 'contribution', 'advance'];
    case DepositPurpose.COMBINED:
      return ['contribution', 'loan', 'advance'];
    default:
      return ['contribution', 'advance'];
  }
}
