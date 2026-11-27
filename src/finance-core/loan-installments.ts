/** DB helpers for loan installment schedules (plain functions over a Prisma client). */
import { InstallmentStatus, MemberLoan, Prisma } from '@prisma/client';
import {
  buildSchedule,
  fillInstallments,
  installmentCount,
  instRemaining,
  statusAfterPayment,
  unearnedInterest,
  type InstallmentState,
} from './loan-schedule';
import { DAY_MS, EPS, dec, decN, roundMoney } from './money.util';

type Db = Prisma.TransactionClient;

const toState = (i: {
  number: number;
  dueDate: Date;
  principal: Prisma.Decimal;
  interest: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
}): InstallmentState => ({
  number: i.number,
  dueDate: i.dueDate,
  principal: decN(i.principal),
  interest: decN(i.interest),
  amountPaid: decN(i.amountPaid),
});

/**
 * (Re)build the schedule of a loan from its snapshots, starting at `start` (the payout date).
 * Only valid while nothing has been paid; sets totalRepayable and dueDate from the schedule.
 */
export async function createSchedule(db: Db, loan: MemberLoan, start: Date) {
  const paid = await db.loanInstallment.count({
    where: { memberLoanId: loan.id, amountPaid: { gt: 0 } },
  });
  if (paid > 0) return;
  const s = buildSchedule({
    principal: decN(loan.principalAmount),
    ratePercent: decN(loan.interestRateSnapshot),
    termDays: loan.repaymentPeriodDaysSnapshot,
    method: loan.interestMethodSnapshot,
    interval: loan.installmentIntervalSnapshot,
    start,
  });
  await db.loanInstallment.deleteMany({ where: { memberLoanId: loan.id } });
  await db.loanInstallment.createMany({
    data: s.lines.map((l) => ({
      memberLoanId: loan.id,
      number: l.number,
      dueDate: l.dueDate,
      principal: dec(l.principal),
      interest: dec(l.interest),
    })),
  });
  await db.memberLoan.update({
    where: { id: loan.id },
    data: {
      totalRepayable: dec(s.totalRepayable),
      dueDate: s.lines[s.lines.length - 1].dueDate,
    },
  });
}

/** Spread a balance payment over the installments (oldest first). */
export async function applyToInstallments(
  db: Db,
  loanId: string,
  amount: number,
  now: Date,
) {
  if (amount < EPS) return;
  const rows = await db.loanInstallment.findMany({
    where: { memberLoanId: loanId },
    orderBy: { number: 'asc' },
  });
  const { out } = fillInstallments(rows.map(toState), amount);
  for (const o of out) {
    const row = rows.find((r) => r.number === o.number)!;
    await db.loanInstallment.update({
      where: { id: row.id },
      data: {
        amountPaid: dec(o.newPaid),
        status: statusAfterPayment(o.full, row.dueDate, now, row.status),
        ...(o.full ? { paidAt: now } : {}),
      },
    });
  }
}

export async function markAllInstallmentsPaid(
  db: Db,
  loanId: string,
  now: Date,
) {
  const rows = await db.loanInstallment.findMany({
    where: { memberLoanId: loanId, status: { not: InstallmentStatus.PAID } },
  });
  for (const r of rows) {
    await db.loanInstallment.update({
      where: { id: r.id },
      data: {
        status: InstallmentStatus.PAID,
        paidAt: now,
        amountPaid: dec(decN(r.principal) + decN(r.interest)),
      },
    });
  }
}

/** Amounts due now / soon, next installment, early-payoff figures. */
export async function scheduleSnapshot(
  db: Db,
  loan: Pick<
    MemberLoan,
    'id' | 'penaltyAccrued' | 'totalRepayable' | 'amountRepaid'
  >,
  now: Date,
  rebatePercent: number,
) {
  const rows = await db.loanInstallment.findMany({
    where: { memberLoanId: loan.id },
    orderBy: { number: 'asc' },
  });
  const states = rows.map(toState);
  const unpaid = states.filter((i) => instRemaining(i) > EPS);
  const overdue = unpaid.filter((i) => i.dueDate < now);
  const next = unpaid.find((i) => i.dueDate >= now) ?? null;
  const overdueAmount = roundMoney(
    overdue.reduce((a, i) => a + instRemaining(i), 0),
  );
  const penalty = roundMoney(decN(loan.penaltyAccrued));
  const balance = roundMoney(
    Math.max(0, decN(loan.totalRepayable) - decN(loan.amountRepaid)),
  );
  const rebate =
    rebatePercent > 0
      ? roundMoney(unearnedInterest(states, now) * (rebatePercent / 100))
      : 0;
  return {
    installments: rows.map((r) => ({
      number: r.number,
      dueDate: r.dueDate.toISOString(),
      principal: decN(r.principal),
      interest: decN(r.interest),
      amount: roundMoney(decN(r.principal) + decN(r.interest)),
      amountPaid: decN(r.amountPaid),
      remaining: instRemaining(toState(r)),
      status: r.status,
    })),
    overdueAmount,
    nextInstallment: next
      ? {
          number: next.number,
          dueDate: next.dueDate.toISOString(),
          amount: instRemaining(next),
        }
      : null,
    /** Penalty + overdue installments + the next installment. */
    dueNow: roundMoney(
      penalty + overdueAmount + (next ? instRemaining(next) : 0),
    ),
    earlyPayoff:
      rebate > EPS && next
        ? { rebate, amount: roundMoney(penalty + balance - rebate) }
        : null,
  };
}

/**
 * Restructure: what is still owed is re-spread from now until `newDueDate` at the loan's
 * installment interval. Paid history is kept; partly paid installments are closed at what was
 * paid and their remainder moves to the new installments.
 */
export async function reschedule(
  db: Db,
  loan: MemberLoan,
  newDueDate: Date,
  now: Date,
) {
  const rows = await db.loanInstallment.findMany({
    where: { memberLoanId: loan.id },
    orderBy: { number: 'asc' },
  });
  let remPrincipal = 0;
  let remInterest = 0;
  for (const r of rows) {
    const st = toState(r);
    const remaining = instRemaining(st);
    if (remaining < EPS) continue;
    const total = st.principal + st.interest;
    const interestShare = total > EPS ? st.interest / total : 0;
    remInterest += remaining * interestShare;
    remPrincipal += remaining * (1 - interestShare);
    if (st.amountPaid > EPS) {
      const paidShare = st.amountPaid / total;
      await db.loanInstallment.update({
        where: { id: r.id },
        data: {
          principal: dec(st.principal * paidShare),
          interest: dec(
            roundMoney(st.amountPaid) - roundMoney(st.principal * paidShare),
          ),
          status: InstallmentStatus.PAID,
          paidAt: now,
        },
      });
    } else {
      await db.loanInstallment.delete({ where: { id: r.id } });
    }
  }
  remPrincipal = roundMoney(remPrincipal);
  remInterest = roundMoney(remInterest);
  const days = Math.max(
    1,
    Math.round((newDueDate.getTime() - now.getTime()) / DAY_MS),
  );
  const n = installmentCount(loan.installmentIntervalSnapshot, days);
  const firstNumber =
    (rows.length ? Math.max(...rows.map((r) => r.number)) : 0) + 1;
  const pEach = roundMoney(remPrincipal / n);
  const iEach = roundMoney(remInterest / n);
  await db.loanInstallment.createMany({
    data: Array.from({ length: n }, (_, k) => {
      const last = k === n - 1;
      return {
        memberLoanId: loan.id,
        number: firstNumber + k,
        dueDate: last
          ? newDueDate
          : new Date(
              now.getTime() +
                ((k + 1) * (newDueDate.getTime() - now.getTime())) / n,
            ),
        principal: dec(last ? remPrincipal - pEach * (n - 1) : pEach),
        interest: dec(last ? remInterest - iEach * (n - 1) : iEach),
      };
    }),
  });
}

/** After money reached a loan's balance: update installments; release guarantors if cleared. */
export async function afterLoanPayment(
  db: Db,
  loanId: string,
  balancePaid: number,
  cleared: boolean,
  now: Date,
) {
  if (cleared) {
    await markAllInstallmentsPaid(db, loanId, now);
    await db.loanGuarantor.updateMany({
      where: { memberLoanId: loanId, status: { in: ['ACCEPTED', 'CALLED'] } },
      data: { status: 'RELEASED', releasedAt: now },
    });
  } else {
    await applyToInstallments(db, loanId, balancePaid, now);
  }
}
