import {
  FineStatus,
  FundType,
  LedgerDirection,
  LedgerEntryType,
  MemberLoanStatus,
  Prisma,
} from '@prisma/client';
import { fundBalances } from '../finance-core/ledger';
import { EPS, decN, roundMoney } from '../finance-core/money.util';
import { loanBalances } from '../finance-core/payment-allocation.service';

type Db = Prisma.TransactionClient;

export interface ShareOutLine {
  userId: string;
  fullName: string;
  openingBalance: number;
  savings: number;
  base: number;
  sharePercent: number;
  profitShare: number;
  grossAmount: number;
  fineDeduction: number;
  loanDeduction: number;
  uncoveredDebt: number;
  netPayout: number;
}

export interface ShareOutResult {
  cycleId: string;
  totals: {
    totalSavings: number;
    totalOpening: number;
    interestIncome: number;
    penaltyIncome: number;
    fineIncome: number;
    otherIncome: number;
    /** Interest, penalties and fines collected by deducting debts from shares at closing. */
    settlementIncome: number;
    expenses: number;
    writeOffLoss: number;
    netProfit: number;
    grossPayout: number;
    deductions: number;
    netPayout: number;
    uncoveredDebt: number;
    /** Savings cash the group holds now (ledger), minus money already committed elsewhere. */
    cashAvailable: number;
    /** > 0 → the group cannot pay everyone yet (collect loans / fines first). */
    cashShortfall: number;
  };
  lines: ShareOutLine[];
}

/**
 * End-of-cycle share-out (savings fund only; the social fund is never shared):
 *   base_m        = savings paid in this cycle + opening balance carried in
 *   net profit    = interest + loan penalties + fines + other ins − expenses − other outs
 *                   + income realised by settling debts from shares (iterated to a fixpoint)
 *                   − unrecovered principal of loans written off in the cycle
 *   profit_m      = net profit × base_m / Σ base
 *   gross_m       = base_m + profit_m
 *   deductions_m  = member's open fines, then open loans (capped at gross)
 *   net payout_m  = gross_m − deductions_m
 */
export async function computeShareOut(
  db: Db,
  cycle: { id: string; groupId: string; startDate: Date; endDate: Date },
  reserved: { payouts: number; otherShareOuts: number },
): Promise<ShareOutResult> {
  const { groupId } = cycle;
  const sums = await db.ledgerEntry.groupBy({
    by: ['type', 'direction', 'userId'],
    where: { groupId, cycleId: cycle.id, fund: FundType.SAVINGS },
    _sum: { amount: true },
  });
  const total = (
    type: LedgerEntryType,
    dir: LedgerDirection,
    userScoped?: boolean,
  ) =>
    roundMoney(
      sums
        .filter(
          (s) =>
            s.type === type &&
            s.direction === dir &&
            (userScoped === undefined ||
              (userScoped ? s.userId != null : s.userId == null)),
        )
        .reduce((a, s) => a + decN(s._sum.amount), 0),
    );

  const savingsBy = new Map<string, number>();
  const openingBy = new Map<string, number>();
  for (const s of sums) {
    if (!s.userId || s.direction !== LedgerDirection.IN) continue;
    if (s.type === LedgerEntryType.CONTRIBUTION) {
      savingsBy.set(
        s.userId,
        roundMoney((savingsBy.get(s.userId) ?? 0) + decN(s._sum.amount)),
      );
    } else if (s.type === LedgerEntryType.OPENING_BALANCE) {
      openingBy.set(
        s.userId,
        roundMoney((openingBy.get(s.userId) ?? 0) + decN(s._sum.amount)),
      );
    }
  }

  const interestIncome = total(
    LedgerEntryType.LOAN_INTEREST,
    LedgerDirection.IN,
  );
  const penaltyIncome = total(LedgerEntryType.LOAN_PENALTY, LedgerDirection.IN);
  const fineIncome = total(LedgerEntryType.FINE, LedgerDirection.IN);
  const otherIncome = roundMoney(
    total(LedgerEntryType.ADJUSTMENT, LedgerDirection.IN) -
      total(LedgerEntryType.ADJUSTMENT, LedgerDirection.OUT),
  );
  const expenses = total(LedgerEntryType.EXPENSE, LedgerDirection.OUT);

  // Loans written off during the cycle: principal never recovered is a loss for everyone.
  const writtenOff = await db.memberLoan.findMany({
    where: {
      groupId,
      status: MemberLoanStatus.WRITTEN_OFF,
      writtenOffAt: { gte: cycle.startDate, lte: cycle.endDate },
    },
    select: { id: true, principalAmount: true },
  });
  let writeOffLoss = 0;
  if (writtenOff.length > 0) {
    const recovered = await db.ledgerEntry.groupBy({
      by: ['memberLoanId'],
      where: {
        memberLoanId: { in: writtenOff.map((l) => l.id) },
        type: LedgerEntryType.LOAN_PRINCIPAL,
        direction: LedgerDirection.IN,
      },
      _sum: { amount: true },
    });
    for (const l of writtenOff) {
      const got = decN(
        recovered.find((r) => r.memberLoanId === l.id)?._sum.amount,
      );
      writeOffLoss += Math.max(0, decN(l.principalAmount) - got);
    }
    writeOffLoss = roundMoney(writeOffLoss);
  }

  const netProfit = roundMoney(
    interestIncome +
      penaltyIncome +
      fineIncome +
      otherIncome -
      expenses -
      writeOffLoss,
  );

  // Members: anyone with a stake in this cycle.
  // Members who left during the cycle already got their savings back (EXIT_REFUND).
  for (const x of sums) {
    if (
      !x.userId ||
      x.direction !== LedgerDirection.OUT ||
      x.type !== LedgerEntryType.EXIT_REFUND
    )
      continue;
    let refunded = decN(x._sum.amount);
    const sav = savingsBy.get(x.userId) ?? 0;
    const fromSavings = Math.min(sav, refunded);
    savingsBy.set(x.userId, roundMoney(sav - fromSavings));
    refunded = roundMoney(refunded - fromSavings);
    const op = openingBy.get(x.userId) ?? 0;
    openingBy.set(x.userId, roundMoney(Math.max(0, op - refunded)));
  }
  const userIds = [
    ...new Set([...savingsBy.keys(), ...openingBy.keys()]),
  ].filter((u) => (savingsBy.get(u) ?? 0) + (openingBy.get(u) ?? 0) > EPS);
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, fullName: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.fullName]));
  const [fines, loans] = await Promise.all([
    db.fine.findMany({
      where: { groupId, userId: { in: userIds }, status: FineStatus.OPEN },
      select: { userId: true, amount: true, amountPaid: true },
    }),
    db.memberLoan.findMany({
      where: {
        groupId,
        userId: { in: userIds },
        status: { in: [MemberLoanStatus.ACTIVE, MemberLoanStatus.DEFAULTED] },
      },
    }),
  ]);

  // Each member's debts in settlement order, with the share of each item that is income
  // (fines and penalties fully; loan balance only its interest part).
  type Debt = { kind: 'fine' | 'loan'; amount: number; incomeShare: number };
  const debtsOf = new Map<string, Debt[]>();
  for (const userId of userIds) {
    const items: Debt[] = [];
    for (const f of fines.filter((x) => x.userId === userId)) {
      const amount = roundMoney(decN(f.amount) - decN(f.amountPaid));
      if (amount > EPS) items.push({ kind: 'fine', amount, incomeShare: 1 });
    }
    for (const l of loans
      .filter((x) => x.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      const { penalty, balance } = loanBalances(l);
      const total = decN(l.totalRepayable);
      if (penalty > EPS)
        items.push({ kind: 'loan', amount: penalty, incomeShare: 1 });
      if (balance > EPS) {
        items.push({
          kind: 'loan',
          amount: balance,
          incomeShare:
            total > EPS ? (total - decN(l.principalAmount)) / total : 0,
        });
      }
    }
    debtsOf.set(userId, items);
  }

  const totalBase = roundMoney(
    userIds.reduce(
      (a, u) => a + (savingsBy.get(u) ?? 0) + (openingBy.get(u) ?? 0),
      0,
    ),
  );

  /** Lines for a given profit, plus the income realised by settling debts from shares. */
  const distribute = (profit: number) => {
    const lines: ShareOutLine[] = userIds.map((userId) => {
      const savings = savingsBy.get(userId) ?? 0;
      const openingBalance = openingBy.get(userId) ?? 0;
      const base = roundMoney(savings + openingBalance);
      const ratio = totalBase > EPS ? base / totalBase : 0;
      return {
        userId,
        fullName: nameOf.get(userId) ?? 'Member',
        openingBalance,
        savings,
        base,
        sharePercent: Math.round(ratio * 10000) / 100,
        profitShare: roundMoney(profit * ratio),
        grossAmount: 0,
        fineDeduction: 0,
        loanDeduction: 0,
        uncoveredDebt: 0,
        netPayout: 0,
      };
    });
    // Rounding: Σ profit shares == profit exactly (residual to the biggest saver).
    const residual = roundMoney(
      profit - lines.reduce((a, l) => a + l.profitShare, 0),
    );
    if (Math.abs(residual) > EPS && lines.length > 0) {
      const top = lines.reduce((a, b) => (b.base > a.base ? b : a));
      top.profitShare = roundMoney(top.profitShare + residual);
    }
    let settledIncome = 0;
    for (const l of lines) {
      l.grossAmount = roundMoney(Math.max(0, l.base + l.profitShare));
      let left = l.grossAmount;
      let debt = 0;
      for (const d of debtsOf.get(l.userId) ?? []) {
        debt += d.amount;
        const pay = roundMoney(Math.min(left, d.amount));
        if (d.kind === 'fine')
          l.fineDeduction = roundMoney(l.fineDeduction + pay);
        else l.loanDeduction = roundMoney(l.loanDeduction + pay);
        settledIncome += pay * d.incomeShare;
        left = roundMoney(left - pay);
      }
      l.uncoveredDebt = roundMoney(debt - l.fineDeduction - l.loanDeduction);
      l.netPayout = left;
    }
    return { lines, settledIncome: roundMoney(settledIncome) };
  };

  // Debts settled from shares bring in interest / penalties / fines that belong to this
  // cycle's profit; the profit in turn changes who can cover their debts — iterate to a fixpoint.
  let settlementIncome = 0;
  let run = distribute(netProfit);
  for (let i = 0; i < 10; i++) {
    const next = run.settledIncome;
    if (Math.abs(next - settlementIncome) < 0.01) break;
    settlementIncome = next;
    run = distribute(roundMoney(netProfit + settlementIncome));
  }
  settlementIncome = run.settledIncome;
  const totalProfit = roundMoney(netProfit + settlementIncome);
  const lines = run.lines.sort((a, b) => b.base - a.base);

  const balances = await fundBalances(db, groupId);
  const cashAvailable = roundMoney(
    Math.max(0, balances.savings - reserved.payouts - reserved.otherShareOuts),
  );
  const sum = (k: keyof ShareOutLine) =>
    roundMoney(lines.reduce((a, l) => a + (l[k] as number), 0));
  const netPayout = sum('netPayout');
  return {
    cycleId: cycle.id,
    totals: {
      totalSavings: sum('savings'),
      totalOpening: sum('openingBalance'),
      interestIncome,
      penaltyIncome,
      fineIncome,
      otherIncome,
      settlementIncome,
      expenses,
      writeOffLoss,
      netProfit: totalProfit,
      grossPayout: sum('grossAmount'),
      deductions: roundMoney(sum('fineDeduction') + sum('loanDeduction')),
      netPayout,
      uncoveredDebt: sum('uncoveredDebt'),
      cashAvailable,
      cashShortfall: roundMoney(Math.max(0, netPayout - cashAvailable)),
    },
    lines,
  };
}
