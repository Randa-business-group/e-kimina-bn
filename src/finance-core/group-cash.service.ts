import { Injectable, Logger } from '@nestjs/common';
import {
  CycleStatus,
  DepositRecordStatus,
  LoanDisbursementStatus,
  Prisma,
  ShareOutStatus,
  SocialPayoutStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { backfillGroupLedger, fundBalances } from './ledger';
import { decN, roundMoney } from './money.util';

type Db = Prisma.TransactionClient;

/**
 * Group cash position from the ledger (msfts §2.1):
 *   savings balance = Σ IN − Σ OUT of the savings fund
 *   available for loans = savings balance − payouts in progress − unpaid share-outs
 *   social available    = social balance − approved, unpaid social payouts
 */
@Injectable()
export class GroupCashService {
  private readonly logger = new Logger(GroupCashService.name);
  private readonly backfilled = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Groups that had money before the ledger existed get their history written once. */
  async ensureLedger(groupId: string, db: Db = this.prisma) {
    if (this.backfilled.has(groupId)) return;
    const [entries, deposits] = await Promise.all([
      db.ledgerEntry.count({ where: { groupId } }),
      db.depositRecord.count({
        where: { groupId, status: DepositRecordStatus.CONFIRMED },
      }),
    ]);
    if (entries === 0 && deposits > 0) {
      const n = await backfillGroupLedger(db, groupId);
      this.logger.log(`Ledger backfilled for group ${groupId}: ${n} entries`);
    }
    this.backfilled.add(groupId);
  }

  async getCashPosition(groupId: string, db: Db = this.prisma) {
    await this.ensureLedger(groupId, db);
    const [balances, pendingPayouts, unpaidShareOuts, approvedSocial] =
      await Promise.all([
        fundBalances(db, groupId),
        db.loanDisbursement.aggregate({
          where: { groupId, status: LoanDisbursementStatus.PENDING },
          _sum: { amount: true },
        }),
        db.shareOut.aggregate({
          where: {
            groupId,
            status: ShareOutStatus.PENDING,
            cycle: { status: CycleStatus.CLOSED },
          },
          _sum: { netPayout: true },
        }),
        db.socialPayout.aggregate({
          where: { groupId, status: SocialPayoutStatus.APPROVED },
          _sum: { amount: true },
        }),
      ]);
    const reservedForPayouts = roundMoney(decN(pendingPayouts._sum.amount));
    const reservedForShareOuts = roundMoney(
      decN(unpaidShareOuts._sum.netPayout),
    );
    const reservedSocial = roundMoney(decN(approvedSocial._sum.amount));
    return {
      savingsBalance: balances.savings,
      socialBalance: balances.social,
      reservedForPayouts,
      reservedForShareOuts,
      reservedSocial,
      /** Savings cash free for new loans, expenses and rotation payouts. */
      available: roundMoney(
        Math.max(
          0,
          balances.savings - reservedForPayouts - reservedForShareOuts,
        ),
      ),
      socialAvailable: roundMoney(
        Math.max(0, balances.social - reservedSocial),
      ),
    };
  }

  async getAvailableCash(groupId: string, db: Db = this.prisma) {
    return (await this.getCashPosition(groupId, db)).available;
  }
}
