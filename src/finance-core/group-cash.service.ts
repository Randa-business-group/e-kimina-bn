import { Injectable } from '@nestjs/common';
import {
  DepositRecordStatus,
  LoanDisbursementStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decN, roundMoney } from './money.util';

type Db = Prisma.TransactionClient;

/**
 * Group cash position until a full ledger exists (msfts §2.1):
 *   cash in  = every CONFIRMED deposit (contributions, fines, loan repayments)
 *   cash out = principal of every loan paid out or being paid out (failed payouts excluded)
 */
@Injectable()
export class GroupCashService {
  constructor(private readonly prisma: PrismaService) {}

  async getCashPosition(groupId: string, db: Db = this.prisma) {
    const [inflow, loans] = await Promise.all([
      db.depositRecord.aggregate({
        where: { groupId, status: DepositRecordStatus.CONFIRMED },
        _sum: { amount: true },
      }),
      db.memberLoan.aggregate({
        where: {
          groupId,
          OR: [
            { disbursement: { is: null } },
            {
              disbursement: {
                is: { status: { not: LoanDisbursementStatus.FAILED } },
              },
            },
          ],
        },
        _sum: { principalAmount: true },
      }),
    ]);
    const cashIn = roundMoney(decN(inflow._sum.amount));
    const loansOut = roundMoney(decN(loans._sum.principalAmount));
    return {
      cashIn,
      loansOut,
      available: roundMoney(Math.max(0, cashIn - loansOut)),
    };
  }

  async getAvailableCash(groupId: string, db: Db = this.prisma) {
    return (await this.getCashPosition(groupId, db)).available;
  }
}
