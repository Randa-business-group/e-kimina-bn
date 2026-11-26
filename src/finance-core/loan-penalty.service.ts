import { Injectable, Logger } from '@nestjs/common';
import {
  LoanDisbursementStatus,
  MemberLoanStatus,
  NotificationType,
} from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { DAY_MS, EPS, addDays, dec, decN, roundMoney } from './money.util';
import { loanBalances } from './payment-allocation.service';

export interface LoanJobResult {
  loansChecked: number;
  penaltiesApplied: number;
  penaltyTotal: number;
  loansDefaulted: number;
}

/**
 * Overdue loans (daily):
 *  - penalty: `penaltyRate`% of the outstanding balance (principal + interest still unpaid)
 *    once per started `penaltyPeriodDays` after dueDate + gracePeriodDays. Idempotent via
 *    `penaltyPeriodsApplied`.
 *  - default: ACTIVE → DEFAULTED once `defaultAfterDays` have passed after dueDate + grace.
 * Loans whose payout is not completed are skipped.
 */
@Injectable()
export class LoanPenaltyService {
  private readonly logger = new Logger(LoanPenaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async runForAllGroups(
    now = new Date(),
    groupId?: string,
  ): Promise<LoanJobResult> {
    const loans = await this.prisma.memberLoan.findMany({
      where: {
        ...(groupId ? { groupId } : {}),
        status: { in: [MemberLoanStatus.ACTIVE, MemberLoanStatus.DEFAULTED] },
        dueDate: { lt: now },
        group: { deletedAt: null },
        OR: [
          { disbursement: { is: null } },
          {
            disbursement: { is: { status: LoanDisbursementStatus.COMPLETED } },
          },
        ],
      },
      include: {
        group: { select: { name: true, loanConfig: true } },
        user: { select: { fullName: true } },
      },
    });

    const result: LoanJobResult = {
      loansChecked: loans.length,
      penaltiesApplied: 0,
      penaltyTotal: 0,
      loansDefaulted: 0,
    };

    for (const loan of loans) {
      try {
        const cfg = loan.group.loanConfig;
        const grace = cfg?.gracePeriodDays ?? 0;
        const periodDays = Math.max(1, cfg?.penaltyPeriodDays ?? 30);
        const start = addDays(loan.dueDate, grace);
        if (now <= start) continue;
        const { balance, outstanding } = loanBalances(loan);
        if (outstanding < EPS) continue;

        const rate = cfg?.penaltyRate != null ? decN(cfg.penaltyRate) : 0;
        const periodsDue =
          Math.floor(
            (now.getTime() - start.getTime()) / (periodDays * DAY_MS),
          ) + 1;
        const newPeriods = periodsDue - loan.penaltyPeriodsApplied;
        let added = 0;
        if (rate > 0 && newPeriods > 0 && balance > EPS) {
          added = roundMoney(balance * (rate / 100) * newPeriods);
        }

        const shouldDefault =
          loan.status === MemberLoanStatus.ACTIVE &&
          cfg?.defaultAfterDays != null &&
          now.getTime() >= addDays(start, cfg.defaultAfterDays).getTime();

        if (added < EPS && newPeriods <= 0 && !shouldDefault) continue;

        await this.prisma.memberLoan.update({
          where: { id: loan.id },
          data: {
            ...(newPeriods > 0 ? { penaltyPeriodsApplied: periodsDue } : {}),
            ...(added > EPS
              ? {
                  penaltyAccrued: dec(decN(loan.penaltyAccrued) + added),
                  lastPenaltyAt: now,
                }
              : {}),
            ...(shouldDefault
              ? { status: MemberLoanStatus.DEFAULTED, defaultedAt: now }
              : {}),
          },
        });

        if (added > EPS) {
          result.penaltiesApplied += 1;
          result.penaltyTotal = roundMoney(result.penaltyTotal + added);
          void this.notifications
            .notifyMember({
              userId: loan.userId,
              groupId: loan.groupId,
              type: NotificationType.LOAN_PENALTY_APPLIED,
              title: 'Loan overdue — penalty added',
              body: `Your loan in ${loan.group.name} is overdue. A penalty of ${added.toFixed(0)} ${loan.currency} was added. Outstanding: ${(outstanding + added).toFixed(0)} ${loan.currency}.`,
              metadata: {
                groupName: loan.group.name,
                memberLoanId: loan.id,
                penalty: added,
              },
            })
            .catch((e) => this.logger.error(e));
        }
        if (shouldDefault) {
          result.loansDefaulted += 1;
          void this.notifications
            .notifyMember({
              userId: loan.userId,
              groupId: loan.groupId,
              type: NotificationType.LOAN_DEFAULTED,
              title: 'Loan marked as defaulted',
              body: `Your loan in ${loan.group.name} is now in default. You can still repay it; contact your group leaders.`,
              metadata: { groupName: loan.group.name, memberLoanId: loan.id },
            })
            .catch((e) => this.logger.error(e));
          void this.notifications
            .notifyFinanceLeaders({
              groupId: loan.groupId,
              type: NotificationType.LOAN_DEFAULTED,
              title: 'Loan defaulted',
              body: `${loan.user.fullName}'s loan in ${loan.group.name} is now in default (${(outstanding + added).toFixed(0)} ${loan.currency} outstanding).`,
              metadata: { groupName: loan.group.name, memberLoanId: loan.id },
            })
            .catch((e) => this.logger.error(e));
        }
      } catch (e) {
        this.logger.error(
          `Loan penalty job failed for loan ${loan.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return result;
  }
}
