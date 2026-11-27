/**
 * Loan schedule maths (msfts §4) — plain functions shared by services, the penalty job and
 * the seed.
 *
 *  - FLAT: interest = principal × rate% for the whole term, split evenly over installments.
 *  - REDUCING: the same nominal rate spread over the installments (r = rate% / n), charged on
 *    the remaining balance; equal (annuity) payments.
 */
import {
  InstallmentInterval,
  InstallmentStatus,
  InterestMethod,
} from '@prisma/client';
import { DAY_MS, EPS, addDays, roundMoney } from './money.util';

export interface ScheduleLine {
  number: number;
  dueDate: Date;
  principal: number;
  interest: number;
}

function addMonthsClamped(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(d.getUTCDate(), last),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ),
  );
}

export function installmentCount(
  interval: InstallmentInterval,
  termDays: number,
): number {
  const step =
    interval === InstallmentInterval.WEEKLY
      ? 7
      : interval === InstallmentInterval.BIWEEKLY
        ? 14
        : 30;
  if (interval === InstallmentInterval.SINGLE) return 1;
  return Math.max(1, Math.round(termDays / step));
}

function dueDateOf(
  interval: InstallmentInterval,
  start: Date,
  k: number,
  termDays: number,
): Date {
  switch (interval) {
    case InstallmentInterval.WEEKLY:
      return addDays(start, 7 * k);
    case InstallmentInterval.BIWEEKLY:
      return addDays(start, 14 * k);
    case InstallmentInterval.MONTHLY:
      return addMonthsClamped(start, k);
    default:
      return addDays(start, termDays);
  }
}

export function buildSchedule(p: {
  principal: number;
  ratePercent: number;
  termDays: number;
  method: InterestMethod;
  interval: InstallmentInterval;
  start: Date;
}): { lines: ScheduleLine[]; totalInterest: number; totalRepayable: number } {
  const n = installmentCount(p.interval, p.termDays);
  const P = roundMoney(p.principal);
  const lines: ScheduleLine[] = [];
  if (p.method === InterestMethod.REDUCING && p.ratePercent > 0 && n > 1) {
    const r = p.ratePercent / 100 / n;
    const payment = (P * r) / (1 - Math.pow(1 + r, -n));
    let balance = P;
    for (let k = 1; k <= n; k++) {
      const interest = roundMoney(balance * r);
      const principal =
        k === n ? roundMoney(balance) : roundMoney(payment - interest);
      balance = roundMoney(balance - principal);
      lines.push({
        number: k,
        dueDate: dueDateOf(p.interval, p.start, k, p.termDays),
        principal,
        interest,
      });
    }
  } else {
    // FLAT (or a single installment, where both methods coincide)
    const totalInterest = roundMoney(P * (p.ratePercent / 100));
    const pEach = roundMoney(P / n);
    const iEach = roundMoney(totalInterest / n);
    for (let k = 1; k <= n; k++) {
      const last = k === n;
      lines.push({
        number: k,
        dueDate: dueDateOf(p.interval, p.start, k, p.termDays),
        principal: last ? roundMoney(P - pEach * (n - 1)) : pEach,
        interest: last ? roundMoney(totalInterest - iEach * (n - 1)) : iEach,
      });
    }
  }
  const totalInterest = roundMoney(lines.reduce((a, l) => a + l.interest, 0));
  return {
    lines,
    totalInterest,
    totalRepayable: roundMoney(P + totalInterest),
  };
}

/**
 * New penalty for one installment: `rate`% of what is still unpaid on it, once per started
 * `periodDays` after dueDate + grace. Returns the periods now due and the amount to add.
 */
export function installmentPenalty(p: {
  dueDate: Date;
  remaining: number;
  periodsApplied: number;
  ratePercent: number;
  graceDays: number;
  periodDays: number;
  now: Date;
}) {
  const start = addDays(p.dueDate, p.graceDays);
  if (p.now <= start || p.remaining < EPS)
    return { periodsDue: p.periodsApplied, add: 0 };
  const periodsDue =
    Math.floor(
      (p.now.getTime() - start.getTime()) /
        (Math.max(1, p.periodDays) * DAY_MS),
    ) + 1;
  const newPeriods = Math.max(0, periodsDue - p.periodsApplied);
  return {
    periodsDue: Math.max(periodsDue, p.periodsApplied),
    add:
      p.ratePercent > 0
        ? roundMoney(p.remaining * (p.ratePercent / 100) * newPeriods)
        : 0,
  };
}

export interface InstallmentState {
  number: number;
  dueDate: Date;
  principal: number;
  interest: number;
  amountPaid: number;
}

export const instTotal = (i: { principal: number; interest: number }) =>
  roundMoney(i.principal + i.interest);
export const instRemaining = (i: InstallmentState) =>
  roundMoney(Math.max(0, instTotal(i) - i.amountPaid));

/** Interest of installments not yet due (unpaid part) — basis of the early-payoff rebate. */
export function unearnedInterest(insts: InstallmentState[], now: Date): number {
  return roundMoney(
    insts
      .filter((i) => i.dueDate > now)
      .reduce((a, i) => {
        const total = instTotal(i);
        const unpaidShare = total > EPS ? instRemaining(i) / total : 0;
        return a + i.interest * unpaidShare;
      }, 0),
  );
}

/** Spread a payment over installments oldest first. Returns per-installment amounts. */
export function fillInstallments(insts: InstallmentState[], amount: number) {
  let left = roundMoney(amount);
  const out: { number: number; pay: number; newPaid: number; full: boolean }[] =
    [];
  for (const i of [...insts].sort((a, b) => a.number - b.number)) {
    if (left < EPS) break;
    const due = instRemaining(i);
    if (due < EPS) continue;
    const pay = roundMoney(Math.min(left, due));
    const newPaid = roundMoney(i.amountPaid + pay);
    out.push({
      number: i.number,
      pay,
      newPaid,
      full: newPaid >= instTotal(i) - EPS,
    });
    left = roundMoney(left - pay);
  }
  return { out, left };
}

export function statusAfterPayment(
  full: boolean,
  dueDate: Date,
  now: Date,
  current: InstallmentStatus,
) {
  if (full) return InstallmentStatus.PAID;
  if (current === InstallmentStatus.LATE || dueDate < now)
    return InstallmentStatus.LATE;
  return InstallmentStatus.PARTIALLY_PAID;
}
