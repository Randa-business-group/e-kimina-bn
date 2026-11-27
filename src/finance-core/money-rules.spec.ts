import {
  DepositPurpose,
  InstallmentInterval,
  InstallmentStatus,
  InterestMethod,
  Prisma,
} from '@prisma/client';
import {
  allocateInOrder,
  allocationSteps,
  splitLoanPayment,
} from './allocation-plan';
import { splitLoanRepayment } from './ledger';
import {
  loanBlockers,
  loanCap,
  type EligibilityFacts,
} from './loan-eligibility';
import {
  buildSchedule,
  fillInstallments,
  installmentCount,
  installmentPenalty,
  statusAfterPayment,
  unearnedInterest,
  type InstallmentState,
} from './loan-schedule';
import { loanBalances } from './payment-allocation.service';
import { roundMoney } from './money.util';

const D = (s: string) => new Date(`${s}T08:00:00.000Z`);
const sum = (xs: number[]) => roundMoney(xs.reduce((a, b) => a + b, 0));

describe('deposit allocation', () => {
  it('pays oldest first and never more than is owed', () => {
    const plan = allocateInOrder(7500, [
      { id: 'fine-1', remaining: 500 },
      { id: 'w1', remaining: 5000 },
      { id: 'w2', remaining: 5000 },
    ]);
    expect(plan.pays).toEqual([
      { id: 'fine-1', pay: 500, full: true },
      { id: 'w1', pay: 5000, full: true },
      { id: 'w2', pay: 2000, full: false },
    ]);
    expect(plan.left).toBe(0);
  });

  it('keeps what is not needed and skips settled items', () => {
    const plan = allocateInOrder(1000, [
      { id: 'a', remaining: 0 },
      { id: 'b', remaining: 300.004 },
    ]);
    expect(plan.pays).toEqual([{ id: 'b', pay: 300, full: true }]);
    expect(plan.left).toBe(700);
  });

  it('handles cents without drift', () => {
    const plan = allocateInOrder(0.3, [
      { id: 'a', remaining: 0.1 },
      { id: 'b', remaining: 0.2 },
    ]);
    expect(sum(plan.pays.map((p) => p.pay))).toBe(0.3);
    expect(plan.left).toBe(0);
  });

  it('spends a deposit in the order its purpose says', () => {
    expect(allocationSteps(DepositPurpose.CONTRIBUTION)).toEqual([
      'contribution',
      'advance',
    ]);
    expect(allocationSteps(DepositPurpose.LOAN_REPAYMENT)).toEqual([
      'loan',
      'contribution',
      'advance',
    ]);
    expect(allocationSteps(DepositPurpose.COMBINED)).toEqual([
      'contribution',
      'loan',
      'advance',
    ]);
  });

  it('pays the loan penalty before principal and interest', () => {
    expect(splitLoanPayment(1000, 300, 5000)).toEqual({
      toPenalty: 300,
      toBalance: 700,
      left: 0,
    });
    expect(splitLoanPayment(6000, 300, 5000)).toEqual({
      toPenalty: 300,
      toBalance: 5000,
      left: 700,
    });
    expect(splitLoanPayment(200, 300, 5000)).toEqual({
      toPenalty: 200,
      toBalance: 0,
      left: 0,
    });
  });

  it('splits flat-interest repayments in the loan proportions', () => {
    const loan = { principalAmount: 100_000, totalRepayable: 105_000 };
    const r = splitLoanRepayment(loan, 21_000);
    expect(r).toEqual({ principal: 20_000, interest: 1_000 });
  });

  it('computes what a borrower owes', () => {
    const b = loanBalances({
      totalRepayable: new Prisma.Decimal(73_500),
      amountRepaid: new Prisma.Decimal(24_500),
      penaltyAccrued: new Prisma.Decimal(1_225),
    });
    expect(b).toEqual({ penalty: 1225, balance: 49_000, outstanding: 50_225 });
  });
});

describe('loan eligibility', () => {
  it('caps by stake × multiplier and by the group cash', () => {
    expect(
      loanCap({
        stake: 50_000,
        allowExceedContribution: true,
        multiplier: 3,
        cashAvailable: 1_000_000,
      }).maxAmount,
    ).toBe(150_000);
    expect(
      loanCap({
        stake: 50_000,
        allowExceedContribution: true,
        multiplier: 3,
        cashAvailable: 90_000,
      }).maxAmount,
    ).toBe(90_000);
    expect(
      loanCap({
        stake: 50_000,
        allowExceedContribution: false,
        multiplier: 3,
        cashAvailable: 1_000_000,
      }).maxAmount,
    ).toBe(50_000);
    expect(
      loanCap({
        stake: 50_000,
        allowExceedContribution: true,
        multiplier: null,
        cashAvailable: 400_000,
      }).maxAmount,
    ).toBe(400_000);
    expect(
      loanCap({
        stake: 0,
        allowExceedContribution: true,
        multiplier: 3,
        cashAvailable: 400_000,
      }).maxAmount,
    ).toBe(0);
  });

  it('lets a top-up count the old balance as already lent', () => {
    const r = loanCap({
      stake: 100_000,
      allowExceedContribution: true,
      multiplier: 3,
      cashAvailable: 20_000,
      topUpBalance: 30_000,
    });
    expect(r.maxAmount).toBe(50_000);
  });

  const ok: EligibilityFacts = {
    topUpRequested: false,
    allowTopUp: false,
    topUpMatches: false,
    topUpActive: false,
    hasOpenLoan: false,
    hasPendingApplication: false,
    writtenOffLoans: 0,
    blockIfArrears: true,
    lateContributions: 0,
    openFines: 0,
    cashAvailable: 500_000,
    constitutionNotAccepted: null,
    maxAmount: 150_000,
  };

  it('allows a member in good standing', () => {
    expect(loanBlockers(ok)).toEqual([]);
  });

  it('explains every reason to refuse', () => {
    expect(loanBlockers({ ...ok, hasOpenLoan: true })[0]).toMatch(
      /unpaid loan/,
    );
    expect(loanBlockers({ ...ok, hasPendingApplication: true })[0]).toMatch(
      /waiting for approval/,
    );
    expect(loanBlockers({ ...ok, writtenOffLoans: 1 })[0]).toMatch(
      /written off/,
    );
    expect(
      loanBlockers({ ...ok, lateContributions: 2, openFines: 500 })[0],
    ).toBe(
      'Clear your arrears first (2 late contributions and 500 RWF in unpaid fines).',
    );
    expect(
      loanBlockers({ ...ok, blockIfArrears: false, lateContributions: 2 }),
    ).toEqual([]);
    expect(loanBlockers({ ...ok, cashAvailable: 0 })[0]).toMatch(/no cash/);
    expect(loanBlockers({ ...ok, constitutionNotAccepted: 3 })[0]).toMatch(
      /version 3/,
    );
    expect(loanBlockers({ ...ok, maxAmount: 0 })[0]).toMatch(
      /not eligible yet/,
    );
    expect(
      loanBlockers({
        ...ok,
        openFines: 5,
        lateContributions: 0,
        currency: 'USD',
      })[0],
    ).toMatch(/5 USD/);
  });

  it('checks top-ups', () => {
    expect(loanBlockers({ ...ok, topUpRequested: true })[0]).toMatch(
      /does not allow/,
    );
    expect(
      loanBlockers({ ...ok, topUpRequested: true, allowTopUp: true })[0],
    ).toMatch(/current loan/);
    expect(
      loanBlockers({
        ...ok,
        topUpRequested: true,
        allowTopUp: true,
        topUpMatches: true,
      })[0],
    ).toMatch(/defaulted/);
    expect(
      loanBlockers({
        ...ok,
        topUpRequested: true,
        allowTopUp: true,
        topUpMatches: true,
        topUpActive: true,
        hasOpenLoan: true,
      }),
    ).toEqual([]);
  });
});

describe('interest', () => {
  it('flat: rate on the principal for the whole term, spread evenly', () => {
    const s = buildSchedule({
      principal: 70_000,
      ratePercent: 5,
      termDays: 90,
      method: InterestMethod.FLAT,
      interval: InstallmentInterval.MONTHLY,
      start: D('2026-10-06'),
    });
    expect(s.lines).toHaveLength(3);
    expect(s.totalInterest).toBe(3_500);
    expect(s.totalRepayable).toBe(73_500);
    expect(sum(s.lines.map((l) => l.principal))).toBe(70_000);
    expect(s.lines[0].dueDate.toISOString().slice(0, 10)).toBe('2026-11-06');
  });

  it('flat: rounding goes to the last installment', () => {
    const s = buildSchedule({
      principal: 100_000,
      ratePercent: 5,
      termDays: 90,
      method: InterestMethod.FLAT,
      interval: InstallmentInterval.MONTHLY,
      start: D('2026-01-31'),
    });
    expect(s.lines.map((l) => l.principal)).toEqual([
      33_333.33, 33_333.33, 33_333.34,
    ]);
    expect(s.lines[0].dueDate.toISOString().slice(0, 10)).toBe('2026-02-28'); // month end clamps
  });

  it('reducing: equal payments, less interest than flat, principal fully repaid', () => {
    const flat = buildSchedule({
      principal: 120_000,
      ratePercent: 12,
      termDays: 180,
      method: InterestMethod.FLAT,
      interval: InstallmentInterval.MONTHLY,
      start: D('2026-01-01'),
    });
    const red = buildSchedule({
      principal: 120_000,
      ratePercent: 12,
      termDays: 180,
      method: InterestMethod.REDUCING,
      interval: InstallmentInterval.MONTHLY,
      start: D('2026-01-01'),
    });
    expect(red.lines).toHaveLength(6);
    expect(sum(red.lines.map((l) => l.principal))).toBe(120_000);
    expect(red.totalInterest).toBeLessThan(flat.totalInterest);
    const payments = red.lines
      .slice(0, -1)
      .map((l) => roundMoney(l.principal + l.interest));
    expect(Math.max(...payments) - Math.min(...payments)).toBeLessThanOrEqual(
      0.02,
    );
  });

  it('counts installments per interval', () => {
    expect(installmentCount(InstallmentInterval.SINGLE, 90)).toBe(1);
    expect(installmentCount(InstallmentInterval.MONTHLY, 90)).toBe(3);
    expect(installmentCount(InstallmentInterval.WEEKLY, 30)).toBe(4);
    expect(installmentCount(InstallmentInterval.BIWEEKLY, 90)).toBe(6);
  });

  it('gives back the interest not yet due on early payoff', () => {
    const insts: InstallmentState[] = [
      {
        number: 1,
        dueDate: D('2026-02-01'),
        principal: 1000,
        interest: 100,
        amountPaid: 1100,
      },
      {
        number: 2,
        dueDate: D('2026-03-01'),
        principal: 1000,
        interest: 100,
        amountPaid: 0,
      },
      {
        number: 3,
        dueDate: D('2026-04-01'),
        principal: 1000,
        interest: 100,
        amountPaid: 550,
      },
    ];
    expect(unearnedInterest(insts, D('2026-02-15'))).toBe(150);
  });
});

describe('penalties', () => {
  const base = {
    dueDate: D('2026-03-01'),
    remaining: 10_000,
    periodsApplied: 0,
    ratePercent: 2,
    graceDays: 3,
    periodDays: 7,
  };

  it('nothing during the grace period', () => {
    expect(installmentPenalty({ ...base, now: D('2026-03-04') })).toEqual({
      periodsDue: 0,
      add: 0,
    });
  });

  it('one period as soon as grace ends, then one per started period', () => {
    expect(installmentPenalty({ ...base, now: D('2026-03-05') })).toEqual({
      periodsDue: 1,
      add: 200,
    });
    expect(installmentPenalty({ ...base, now: D('2026-03-12') })).toEqual({
      periodsDue: 2,
      add: 400,
    });
  });

  it('only charges new periods (idempotent across daily runs)', () => {
    expect(
      installmentPenalty({ ...base, periodsApplied: 2, now: D('2026-03-12') }),
    ).toEqual({ periodsDue: 2, add: 0 });
    expect(
      installmentPenalty({ ...base, periodsApplied: 2, now: D('2026-03-17') }),
    ).toEqual({ periodsDue: 2, add: 0 });
    // grace ends 4 Mar → periods start 4, 11, 18 Mar
    expect(
      installmentPenalty({ ...base, periodsApplied: 2, now: D('2026-03-18') }),
    ).toEqual({ periodsDue: 3, add: 200 });
  });

  it('no penalty on a paid installment or with a 0% rate', () => {
    expect(
      installmentPenalty({ ...base, remaining: 0, now: D('2026-04-01') }).add,
    ).toBe(0);
    expect(
      installmentPenalty({ ...base, ratePercent: 0, now: D('2026-04-01') }).add,
    ).toBe(0);
  });

  it('fills installments oldest first and marks their status', () => {
    const insts: InstallmentState[] = [
      {
        number: 2,
        dueDate: D('2026-03-01'),
        principal: 1000,
        interest: 50,
        amountPaid: 0,
      },
      {
        number: 1,
        dueDate: D('2026-02-01'),
        principal: 1000,
        interest: 50,
        amountPaid: 1000,
      },
    ];
    const r = fillInstallments(insts, 600);
    expect(r.out).toEqual([
      { number: 1, pay: 50, newPaid: 1050, full: true },
      { number: 2, pay: 550, newPaid: 550, full: false },
    ]);
    expect(
      statusAfterPayment(
        true,
        D('2026-02-01'),
        D('2026-02-15'),
        InstallmentStatus.LATE,
      ),
    ).toBe(InstallmentStatus.PAID);
    expect(
      statusAfterPayment(
        false,
        D('2026-03-01'),
        D('2026-02-15'),
        InstallmentStatus.PENDING,
      ),
    ).toBe(InstallmentStatus.PARTIALLY_PAID);
    expect(
      statusAfterPayment(
        false,
        D('2026-02-01'),
        D('2026-02-15'),
        InstallmentStatus.PENDING,
      ),
    ).toBe(InstallmentStatus.LATE);
  });
});
