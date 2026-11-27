/**
 * Group cash book helpers (msfts §2.1). Plain functions over a Prisma client so they can be
 * used by Nest services, the scheduler and the seed alike.
 *
 * Every entry has a unique `sourceKey`, so writes are idempotent: the live writers and the
 * backfill can both run without ever double-counting a movement.
 */
import {
  AllocationKind,
  DepositPurpose,
  DepositRecordStatus,
  ExpenseStatus,
  FundType,
  LedgerDirection,
  LedgerEntryType,
  LoanDisbursementStatus,
  Prisma,
  SocialPayoutStatus,
} from '@prisma/client';
import { EPS, dec, decN, roundMoney } from './money.util';

type Db = Prisma.TransactionClient;

export interface LedgerInput {
  groupId: string;
  type: LedgerEntryType;
  direction: LedgerDirection;
  amount: number;
  sourceKey: string;
  occurredAt: Date;
  fund?: FundType;
  userId?: string | null;
  depositId?: string | null;
  allocationId?: string | null;
  contributionId?: string | null;
  fineId?: string | null;
  memberLoanId?: string | null;
  disbursementId?: string | null;
  expenseId?: string | null;
  socialPayoutId?: string | null;
  shareOutId?: string | null;
  rotationSlotId?: string | null;
  description?: string | null;
  createdById?: string | null;
  /** Force a cycle instead of resolving it from occurredAt. */
  cycleId?: string | null;
}

/** Returns date → cycleId for a group (cycles are inclusive on both ends). */
export async function cycleResolver(db: Db, groupId: string) {
  const cycles = await db.groupCycle.findMany({
    where: { groupId },
    select: { id: true, startDate: true, endDate: true },
    orderBy: { startDate: 'asc' },
  });
  return (d: Date): string | null =>
    cycles.find((c) => d >= c.startDate && d <= c.endDate)?.id ?? null;
}

/** Insert entries (skips ones whose sourceKey already exists). Returns rows inserted. */
export async function writeLedger(
  db: Db,
  entries: LedgerInput[],
): Promise<number> {
  const rows = entries.filter((e) => e.amount > EPS);
  if (rows.length === 0) return 0;
  const resolvers = new Map<string, (d: Date) => string | null>();
  for (const g of new Set(rows.map((r) => r.groupId))) {
    resolvers.set(g, await cycleResolver(db, g));
  }
  const res = await db.ledgerEntry.createMany({
    data: rows.map((e) => ({
      groupId: e.groupId,
      cycleId:
        e.cycleId !== undefined
          ? e.cycleId
          : resolvers.get(e.groupId)!(e.occurredAt),
      userId: e.userId ?? null,
      fund: e.fund ?? FundType.SAVINGS,
      type: e.type,
      direction: e.direction,
      amount: dec(e.amount),
      sourceKey: e.sourceKey,
      depositId: e.depositId ?? null,
      allocationId: e.allocationId ?? null,
      contributionId: e.contributionId ?? null,
      fineId: e.fineId ?? null,
      memberLoanId: e.memberLoanId ?? null,
      disbursementId: e.disbursementId ?? null,
      expenseId: e.expenseId ?? null,
      socialPayoutId: e.socialPayoutId ?? null,
      shareOutId: e.shareOutId ?? null,
      rotationSlotId: e.rotationSlotId ?? null,
      description: e.description ?? null,
      createdById: e.createdById ?? null,
      occurredAt: e.occurredAt,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

/** Flat interest: every repayment is principal and interest in the loan's proportions. */
export function splitLoanRepayment(
  loan: {
    principalAmount: Prisma.Decimal | number;
    totalRepayable: Prisma.Decimal | number;
  },
  amount: number,
) {
  const total = decN(loan.totalRepayable);
  const principalTotal = decN(loan.principalAmount);
  if (total <= EPS) return { principal: roundMoney(amount), interest: 0 };
  const interest = roundMoney(amount * ((total - principalTotal) / total));
  return { principal: roundMoney(amount - interest), interest };
}

/** Ledger lines for one confirmed deposit, from its allocations (or legacy portions). */
export async function ledgerEntriesForDeposit(
  db: Db,
  deposit: {
    id: string;
    groupId: string;
    userId: string;
    purpose: DepositPurpose;
    memberLoanId: string | null;
    contributionPortion: Prisma.Decimal;
    finePortion: Prisma.Decimal;
    installmentPortion: Prisma.Decimal;
    reviewedAt: Date | null;
    createdAt: Date;
  },
): Promise<LedgerInput[]> {
  const at = deposit.reviewedAt ?? deposit.createdAt;
  const base = {
    groupId: deposit.groupId,
    userId: deposit.userId,
    depositId: deposit.id,
    occurredAt: at,
  };
  const allocations = await db.depositAllocation.findMany({
    where: { depositId: deposit.id },
    include: {
      contribution: { select: { fund: true, cycleId: true } },
      memberLoan: { select: { principalAmount: true, totalRepayable: true } },
    },
  });
  const out: LedgerInput[] = [];
  const IN = LedgerDirection.IN;

  if (allocations.length > 0) {
    for (const a of allocations) {
      const amount = decN(a.amount);
      const common = { ...base, allocationId: a.id, direction: IN };
      switch (a.kind) {
        case AllocationKind.CONTRIBUTION:
          out.push({
            ...common,
            type: LedgerEntryType.CONTRIBUTION,
            fund: a.contribution?.fund ?? FundType.SAVINGS,
            // Savings belong to the cycle of the period they pay (early payments included).
            cycleId: a.contribution?.cycleId ?? undefined,
            amount,
            contributionId: a.contributionId,
            sourceKey: `alloc:${a.id}`,
          });
          break;
        case AllocationKind.FINE:
          out.push({
            ...common,
            type: LedgerEntryType.FINE,
            amount,
            fineId: a.fineId,
            sourceKey: `alloc:${a.id}`,
          });
          break;
        case AllocationKind.LOAN_PENALTY:
          out.push({
            ...common,
            type: LedgerEntryType.LOAN_PENALTY,
            amount,
            memberLoanId: a.memberLoanId,
            sourceKey: `alloc:${a.id}`,
          });
          break;
        case AllocationKind.LOAN_REPAYMENT: {
          const split = a.memberLoan
            ? splitLoanRepayment(a.memberLoan, amount)
            : { principal: amount, interest: 0 };
          out.push({
            ...common,
            type: LedgerEntryType.LOAN_PRINCIPAL,
            amount: split.principal,
            memberLoanId: a.memberLoanId,
            sourceKey: `alloc:${a.id}:principal`,
          });
          out.push({
            ...common,
            type: LedgerEntryType.LOAN_INTEREST,
            amount: split.interest,
            memberLoanId: a.memberLoanId,
            sourceKey: `alloc:${a.id}:interest`,
          });
          break;
        }
      }
    }
    return out;
  }

  // Legacy deposit (before allocations existed): use the stored portions.
  const contribution = decN(deposit.contributionPortion);
  const fine = decN(deposit.finePortion);
  const installment = decN(deposit.installmentPortion);
  const isLoan = deposit.purpose === DepositPurpose.LOAN_REPAYMENT;
  out.push({
    ...base,
    direction: IN,
    type: LedgerEntryType.CONTRIBUTION,
    amount: contribution,
    sourceKey: `dep:${deposit.id}:contribution`,
  });
  out.push({
    ...base,
    direction: IN,
    type: isLoan ? LedgerEntryType.LOAN_PENALTY : LedgerEntryType.FINE,
    amount: fine,
    memberLoanId: isLoan ? deposit.memberLoanId : null,
    sourceKey: `dep:${deposit.id}:fine`,
  });
  if (installment > EPS && deposit.memberLoanId) {
    const loan = await db.memberLoan.findUnique({
      where: { id: deposit.memberLoanId },
      select: { principalAmount: true, totalRepayable: true },
    });
    const split = loan
      ? splitLoanRepayment(loan, installment)
      : { principal: installment, interest: 0 };
    out.push({
      ...base,
      direction: IN,
      type: LedgerEntryType.LOAN_PRINCIPAL,
      amount: split.principal,
      memberLoanId: deposit.memberLoanId,
      sourceKey: `dep:${deposit.id}:principal`,
    });
    out.push({
      ...base,
      direction: IN,
      type: LedgerEntryType.LOAN_INTEREST,
      amount: split.interest,
      memberLoanId: deposit.memberLoanId,
      sourceKey: `dep:${deposit.id}:interest`,
    });
  }
  return out;
}

/** OUT entry for a completed loan payout. */
export function disbursementEntry(d: {
  id: string;
  groupId: string;
  memberLoanId: string;
  amount: Prisma.Decimal;
  completedAt: Date | null;
  createdAt: Date;
  userId: string;
  disbursedById?: string | null;
}): LedgerInput {
  return {
    groupId: d.groupId,
    userId: d.userId,
    type: LedgerEntryType.LOAN_DISBURSEMENT,
    direction: LedgerDirection.OUT,
    amount: decN(d.amount),
    memberLoanId: d.memberLoanId,
    disbursementId: d.id,
    createdById: d.disbursedById ?? null,
    occurredAt: d.completedAt ?? d.createdAt,
    sourceKey: `disb:${d.id}`,
  };
}

/**
 * Rebuild every derivable entry for a group (deposits, payouts, approved expenses, paid social
 * payouts). Idempotent; safe to run at any time.
 */
export async function backfillGroupLedger(
  db: Db,
  groupId: string,
): Promise<number> {
  let inserted = 0;
  const deposits = await db.depositRecord.findMany({
    where: { groupId, status: DepositRecordStatus.CONFIRMED },
  });
  for (let i = 0; i < deposits.length; i += 200) {
    const batch: LedgerInput[] = [];
    for (const d of deposits.slice(i, i + 200)) {
      batch.push(...(await ledgerEntriesForDeposit(db, d)));
    }
    inserted += await writeLedger(db, batch);
  }

  const loans = await db.memberLoan.findMany({
    where: { groupId },
    include: { disbursement: true },
  });
  inserted += await writeLedger(
    db,
    loans.flatMap((l): LedgerInput[] => {
      if (!l.disbursement) {
        return [
          {
            groupId,
            userId: l.userId,
            type: LedgerEntryType.LOAN_DISBURSEMENT,
            direction: LedgerDirection.OUT,
            amount: decN(l.principalAmount),
            memberLoanId: l.id,
            occurredAt: l.disbursedAt,
            sourceKey: `loan:${l.id}:disb`,
          },
        ];
      }
      if (l.disbursement.status !== LoanDisbursementStatus.COMPLETED) return [];
      return [disbursementEntry({ ...l.disbursement, userId: l.userId })];
    }),
  );

  const expenses = await db.expense.findMany({
    where: { groupId, status: ExpenseStatus.APPROVED },
  });
  inserted += await writeLedger(db, expenses.map(expenseEntry));

  const payouts = await db.socialPayout.findMany({
    where: { groupId, status: SocialPayoutStatus.PAID },
  });
  inserted += await writeLedger(db, payouts.map(socialPayoutEntry));
  return inserted;
}

export function expenseEntry(e: {
  id: string;
  groupId: string;
  fund: FundType;
  amount: Prisma.Decimal;
  category: string;
  description: string;
  occurredAt: Date;
  approvedById: string | null;
}): LedgerInput {
  return {
    groupId: e.groupId,
    fund: e.fund,
    type: LedgerEntryType.EXPENSE,
    direction: LedgerDirection.OUT,
    amount: decN(e.amount),
    expenseId: e.id,
    description: `${e.category}: ${e.description}`,
    createdById: e.approvedById,
    occurredAt: e.occurredAt,
    sourceKey: `expense:${e.id}`,
  };
}

export function socialPayoutEntry(p: {
  id: string;
  groupId: string;
  beneficiaryUserId: string;
  amount: Prisma.Decimal;
  reason: string;
  paidAt: Date | null;
  updatedAt: Date;
  paidById: string | null;
}): LedgerInput {
  return {
    groupId: p.groupId,
    userId: p.beneficiaryUserId,
    fund: FundType.SOCIAL,
    type: LedgerEntryType.SOCIAL_PAYOUT,
    direction: LedgerDirection.OUT,
    amount: decN(p.amount),
    socialPayoutId: p.id,
    description: `Social fund payout (${p.reason})`,
    createdById: p.paidById,
    occurredAt: p.paidAt ?? p.updatedAt,
    sourceKey: `social:${p.id}`,
  };
}

/** Σ IN − Σ OUT per fund (optionally for one cycle). */
export async function fundBalances(
  db: Db,
  groupId: string,
  cycleId?: string | null,
) {
  const rows = await db.ledgerEntry.groupBy({
    by: ['fund', 'direction'],
    where: { groupId, ...(cycleId !== undefined ? { cycleId } : {}) },
    _sum: { amount: true },
  });
  const get = (fund: FundType, dir: LedgerDirection) =>
    decN(rows.find((r) => r.fund === fund && r.direction === dir)?._sum.amount);
  return {
    savings: roundMoney(
      get(FundType.SAVINGS, LedgerDirection.IN) -
        get(FundType.SAVINGS, LedgerDirection.OUT),
    ),
    social: roundMoney(
      get(FundType.SOCIAL, LedgerDirection.IN) -
        get(FundType.SOCIAL, LedgerDirection.OUT),
    ),
  };
}
