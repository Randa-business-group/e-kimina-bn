import { Injectable, Logger } from '@nestjs/common';
import {
  InstallmentStatus,
  LoanDisbursementStatus,
  MemberLoanStatus,
  NotificationType,
} from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { installmentPenalty } from './loan-schedule';
import { EPS, addDays, dec, decN, roundMoney } from './money.util';
import { loanBalances } from './payment-allocation.service';

export interface LoanJobResult {
  loansChecked: number;
  penaltiesApplied: number;
  penaltyTotal: number;
  loansDefaulted: number;
  installmentsMarkedLate: number;
  remindersSent: number;
}

const REMINDER_DAYS = 3;

/**
 * Overdue loans (daily), per installment (msfts §4.1):
 *  - an installment past dueDate + grace turns LATE;
 *  - penalty: `penaltyRate`% of what is unpaid on each overdue installment, once per started
 *    `penaltyPeriodDays` (idempotent via `penaltyPeriodsApplied`), added to the loan's penalty;
 *  - default: ACTIVE → DEFAULTED `defaultAfterDays` after the oldest overdue installment's
 *    dueDate + grace;
 *  - reminder 3 days before each installment is due.
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
        installments: { orderBy: { number: 'asc' } },
      },
    });

    const result: LoanJobResult = {
      loansChecked: loans.length,
      penaltiesApplied: 0,
      penaltyTotal: 0,
      loansDefaulted: 0,
      installmentsMarkedLate: 0,
      remindersSent: 0,
    };

    for (const loan of loans) {
      try {
        const cfg = loan.group.loanConfig;
        const grace = cfg?.gracePeriodDays ?? 0;
        const periodDays = Math.max(1, cfg?.penaltyPeriodDays ?? 30);
        const rate = cfg?.penaltyRate != null ? decN(cfg.penaltyRate) : 0;
        if (loanBalances(loan).outstanding < EPS) continue;

        let added = 0;
        let newlyLate = 0;
        let oldestOverdueStart: Date | null = null;
        let maxPeriods = 0;
        for (const inst of loan.installments) {
          const remaining = roundMoney(
            decN(inst.principal) + decN(inst.interest) - decN(inst.amountPaid),
          );
          if (remaining < EPS) continue;
          const graceEnd = addDays(inst.dueDate, grace);
          if (now > graceEnd) {
            oldestOverdueStart ??= graceEnd;
            const pen = installmentPenalty({
              dueDate: inst.dueDate,
              remaining,
              periodsApplied: inst.penaltyPeriodsApplied,
              ratePercent: rate,
              graceDays: grace,
              periodDays,
              now,
            });
            const becameLate = inst.status !== InstallmentStatus.LATE;
            if (pen.periodsDue !== inst.penaltyPeriodsApplied || becameLate) {
              await this.prisma.loanInstallment.update({
                where: { id: inst.id },
                data: {
                  penaltyPeriodsApplied: pen.periodsDue,
                  ...(becameLate
                    ? { status: InstallmentStatus.LATE, lateMarkedAt: now }
                    : {}),
                },
              });
            }
            if (becameLate) newlyLate++;
            maxPeriods = Math.max(maxPeriods, pen.periodsDue);
            added = roundMoney(added + pen.add);
          } else if (
            !inst.reminderSentAt &&
            inst.dueDate > now &&
            inst.dueDate <= addDays(now, REMINDER_DAYS)
          ) {
            await this.prisma.loanInstallment.update({
              where: { id: inst.id },
              data: { reminderSentAt: now },
            });
            result.remindersSent++;
            void this.notifications
              .notifyMember({
                userId: loan.userId,
                groupId: loan.groupId,
                type: NotificationType.LOAN_INSTALLMENT_DUE,
                title: 'Loan installment due soon',
                body: `Installment ${inst.number} of your loan in ${loan.group.name} (${remaining.toFixed(0)} ${loan.currency}) is due on ${inst.dueDate.toISOString().slice(0, 10)}.`,
                metadata: {
                  groupName: loan.group.name,
                  memberLoanId: loan.id,
                  installment: inst.number,
                },
              })
              .catch((e) => this.logger.error(e));
          }
        }
        result.installmentsMarkedLate += newlyLate;

        const shouldDefault =
          loan.status === MemberLoanStatus.ACTIVE &&
          cfg?.defaultAfterDays != null &&
          oldestOverdueStart != null &&
          now.getTime() >=
            addDays(oldestOverdueStart, cfg.defaultAfterDays).getTime();

        if (added > EPS || shouldDefault) {
          await this.prisma.memberLoan.update({
            where: { id: loan.id },
            data: {
              ...(added > EPS
                ? {
                    penaltyAccrued: dec(decN(loan.penaltyAccrued) + added),
                    lastPenaltyAt: now,
                    penaltyPeriodsApplied: maxPeriods,
                  }
                : {}),
              ...(shouldDefault
                ? { status: MemberLoanStatus.DEFAULTED, defaultedAt: now }
                : {}),
            },
          });
        }

        const outstanding = roundMoney(loanBalances(loan).outstanding + added);
        if (added > EPS) {
          result.penaltiesApplied += 1;
          result.penaltyTotal = roundMoney(result.penaltyTotal + added);
          void this.notifications
            .notifyMember({
              userId: loan.userId,
              groupId: loan.groupId,
              type: NotificationType.LOAN_PENALTY_APPLIED,
              title: 'Loan overdue — penalty added',
              body: `Your loan in ${loan.group.name} has overdue installments. A penalty of ${added.toFixed(0)} ${loan.currency} was added. Outstanding: ${outstanding.toFixed(0)} ${loan.currency}.`,
              metadata: {
                groupName: loan.group.name,
                memberLoanId: loan.id,
                penalty: added,
              },
            })
            .catch((e) => this.logger.error(e));
        } else if (newlyLate > 0) {
          void this.notifications
            .notifyMember({
              userId: loan.userId,
              groupId: loan.groupId,
              type: NotificationType.LOAN_INSTALLMENT_LATE,
              title: 'Loan installment overdue',
              body: `${newlyLate} installment${newlyLate > 1 ? 's' : ''} of your loan in ${loan.group.name} ${newlyLate > 1 ? 'are' : 'is'} overdue.`,
              metadata: { groupName: loan.group.name, memberLoanId: loan.id },
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
              body: `${loan.user.fullName}'s loan in ${loan.group.name} is now in default (${outstanding.toFixed(0)} ${loan.currency} outstanding). Guarantees can be called.`,
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
