import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ContributionScheduleService } from '../finance-core/contribution-schedule.service';
import { LoanPenaltyService } from '../finance-core/loan-penalty.service';
import { GroupFinanceService } from './group-finance.service';
import { GroupLoansService } from './group-loans.service';

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Background money jobs (no extra dependency, plain timers):
 *  - daily at FINANCE_DAILY_JOB_HOUR_UTC (default 03:00 UTC = 05:00 Kigali) and ~20s after boot:
 *    generate contribution periods, mark LATE + issue fines, reminders, loan penalties/defaults;
 *  - every MOMO_POLL_INTERVAL_SECONDS (default 60): refresh pending MoMo payments and payouts.
 * Everything is idempotent, so running twice (or on several instances) does no harm.
 * Disable with FINANCE_JOBS_ENABLED=false.
 */
@Injectable()
export class FinanceJobsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(FinanceJobsService.name);
  private timers: NodeJS.Timeout[] = [];
  private dailyRunning = false;
  private pollRunning = false;

  constructor(
    private readonly schedule: ContributionScheduleService,
    private readonly loanPenalties: LoanPenaltyService,
    private readonly groupFinance: GroupFinanceService,
    private readonly groupLoans: GroupLoansService,
  ) {}

  onApplicationBootstrap() {
    if (
      process.env.FINANCE_JOBS_ENABLED === 'false' ||
      process.env.NODE_ENV === 'test'
    ) {
      this.logger.log('Finance jobs disabled.');
      return;
    }
    this.timers.push(setTimeout(() => void this.runDailySafe(), 20_000));
    this.scheduleNextDaily();
    const pollMs =
      Math.max(15, envInt('MOMO_POLL_INTERVAL_SECONDS', 60)) * 1000;
    this.timers.push(setInterval(() => void this.pollSafe(), pollMs));
  }

  onModuleDestroy() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private scheduleNextDaily() {
    const hour = Math.min(
      23,
      Math.max(0, envInt('FINANCE_DAILY_JOB_HOUR_UTC', 3)),
    );
    const now = new Date();
    const next = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        hour,
        0,
        0,
      ),
    );
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const t = setTimeout(
      () => {
        void this.runDailySafe().finally(() => this.scheduleNextDaily());
      },
      next.getTime() - now.getTime() + 1000,
    );
    this.timers.push(t);
  }

  private async runDailySafe() {
    try {
      const r = await this.runDaily();
      this.logger.log(
        `Daily finance jobs: ${r.groups} groups, +${r.rowsCreated} periods, ${r.rowsMarkedLate} late, ${r.finesIssued} fines, ${r.remindersSent} reminders, ${r.loans.penaltiesApplied} loan penalties, ${r.loans.loansDefaulted} defaults (${r.ms} ms)`,
      );
    } catch (e) {
      this.logger.error(
        `Daily finance jobs failed: ${e instanceof Error ? e.stack : String(e)}`,
      );
    }
  }

  /** Run every daily job now, for one group or all. */
  async runDaily(groupId?: string) {
    if (this.dailyRunning && !groupId) {
      throw new Error('Daily finance jobs are already running.');
    }
    if (!groupId) this.dailyRunning = true;
    const started = Date.now();
    try {
      const now = new Date();
      const results = groupId
        ? [await this.schedule.runForGroup(groupId, now)]
        : await this.schedule.runForAllGroups(now);
      const loans = await this.loanPenalties.runForAllGroups(now, groupId);
      const sum = (
        k: 'rowsCreated' | 'rowsMarkedLate' | 'finesIssued' | 'remindersSent',
      ) => results.reduce((s, r) => s + r[k], 0);
      return {
        groups: results.length,
        rowsCreated: sum('rowsCreated'),
        rowsMarkedLate: sum('rowsMarkedLate'),
        finesIssued: sum('finesIssued'),
        remindersSent: sum('remindersSent'),
        loans,
        ms: Date.now() - started,
      };
    } finally {
      if (!groupId) this.dailyRunning = false;
    }
  }

  private async pollSafe() {
    if (this.pollRunning) return;
    this.pollRunning = true;
    try {
      await this.groupFinance.pollPendingMomoDeposits();
      await this.groupLoans.pollPendingDisbursements();
    } catch (e) {
      this.logger.error(
        `MoMo polling failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.pollRunning = false;
    }
  }
}
