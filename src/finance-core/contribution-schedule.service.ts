import { Injectable, Logger } from '@nestjs/common';
import {
  ContributionConfig,
  ContributionStatus,
  FineStatus,
  FineType,
  GroupMembershipStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, dec, decN, roundMoney, startOfUtcDay } from './money.util';
import {
  dueDatesBetween,
  firstDueAfter,
  periodLengthDays,
  type ScheduleConfig,
} from './schedule.util';

type Db = Prisma.TransactionClient;

const OPEN_STATUSES: ContributionStatus[] = [
  ContributionStatus.PENDING,
  ContributionStatus.PARTIALLY_PAID,
  ContributionStatus.LATE,
];

export interface ScheduleRunResult {
  groupId: string;
  rowsCreated: number;
  rowsMarkedLate: number;
  finesIssued: number;
  remindersSent: number;
}

/**
 * Generates per-period `Contribution` rows from `ContributionConfig`, marks rows LATE after
 * dueDate + gracePeriodDays and issues the late fine (frozen at the rate in force).
 * Every operation is idempotent (unique userId+groupId+dueDate, unique fine per row).
 */
@Injectable()
export class ContributionScheduleService {
  private readonly logger = new Logger(ContributionScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  static readonly OPEN_STATUSES = OPEN_STATUSES;

  private toSchedule(cfg: ContributionConfig): ScheduleConfig {
    return {
      interval: cfg.interval,
      startDate: cfg.startDate,
      dayOfWeek: cfg.dayOfWeek,
      dayOfMonth: cfg.dayOfMonth,
    };
  }

  /** Rows are generated up to now + one period so the upcoming period is always visible. */
  private horizon(cfg: ContributionConfig, now: Date): Date {
    return addDays(now, periodLengthDays(cfg.interval));
  }

  private memberAmount(
    cfg: ContributionConfig,
    custom: Prisma.Decimal | null | undefined,
  ): Prisma.Decimal {
    return custom != null && decN(custom) > 0 ? custom : cfg.amount;
  }

  /** Create missing rows for every ACTIVE member of a group. Returns rows created. */
  async ensureGroupRows(
    groupId: string,
    now = new Date(),
    db: Db = this.prisma,
  ) {
    const cfg = await db.contributionConfig.findUnique({ where: { groupId } });
    if (!cfg) return 0;
    const members = await db.userGroup.findMany({
      where: { groupId, membershipStatus: GroupMembershipStatus.ACTIVE },
      select: { userId: true, joinedAt: true, customContributionAmount: true },
    });
    let created = 0;
    for (const m of members) {
      created += await this.ensureRowsForMember(db, cfg, m, now);
    }
    return created;
  }

  /** Create missing rows for a single member (on join / invite). */
  async ensureMemberRows(
    groupId: string,
    userId: string,
    now = new Date(),
    db: Db = this.prisma,
  ) {
    const cfg = await db.contributionConfig.findUnique({ where: { groupId } });
    if (!cfg) return 0;
    const m = await db.userGroup.findUnique({
      where: { userId_groupId: { userId, groupId } },
      select: {
        userId: true,
        joinedAt: true,
        customContributionAmount: true,
        membershipStatus: true,
      },
    });
    if (!m || m.membershipStatus !== GroupMembershipStatus.ACTIVE) return 0;
    return this.ensureRowsForMember(db, cfg, m, now);
  }

  private async ensureRowsForMember(
    db: Db,
    cfg: ContributionConfig,
    m: {
      userId: string;
      joinedAt: Date;
      customContributionAmount: Prisma.Decimal | null;
    },
    now: Date,
  ) {
    // Prorated from the join date: first period due on/after the day the member joined.
    const from = startOfUtcDay(m.joinedAt);
    const dates = dueDatesBetween(
      this.toSchedule(cfg),
      from,
      this.horizon(cfg, now),
    );
    if (dates.length === 0) return 0;
    const amount = this.memberAmount(cfg, m.customContributionAmount);
    const res = await db.contribution.createMany({
      data: dates.map((dueDate) => ({
        userId: m.userId,
        groupId: cfg.groupId,
        amount,
        dueDate,
        status: ContributionStatus.PENDING,
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  /**
   * Advance payment: create the member's next period row after their latest row
   * (or their first period). Used when a deposit exceeds everything currently owed.
   */
  async createNextPeriodRow(db: Db, groupId: string, userId: string) {
    const cfg = await db.contributionConfig.findUnique({ where: { groupId } });
    if (!cfg) return null;
    const m = await db.userGroup.findUnique({
      where: { userId_groupId: { userId, groupId } },
      select: { joinedAt: true, customContributionAmount: true },
    });
    const latest = await db.contribution.findFirst({
      where: { userId, groupId },
      orderBy: { dueDate: 'desc' },
      select: { dueDate: true },
    });
    const after = latest
      ? latest.dueDate
      : new Date(startOfUtcDay(m?.joinedAt ?? new Date()).getTime() - 1);
    const dueDate = firstDueAfter(this.toSchedule(cfg), after);
    return db.contribution.create({
      data: {
        userId,
        groupId,
        amount: this.memberAmount(cfg, m?.customContributionAmount),
        dueDate,
        status: ContributionStatus.PENDING,
      },
    });
  }

  /**
   * PENDING / PARTIALLY_PAID rows past dueDate + grace → LATE, then issue the late fine
   * (amount × latePenaltyRate %, frozen now). Rows that fell due before the rules were
   * configured are marked LATE but are not fined automatically.
   */
  async markLateAndIssueFines(groupId: string, now = new Date()) {
    const cfg = await this.prisma.contributionConfig.findUnique({
      where: { groupId },
      include: { group: { select: { name: true } } },
    });
    if (!cfg) return { rowsMarkedLate: 0, finesIssued: 0 };

    const lateBefore = addDays(now, -cfg.gracePeriodDays);
    const newlyLate = await this.prisma.contribution.findMany({
      where: {
        groupId,
        status: {
          in: [ContributionStatus.PENDING, ContributionStatus.PARTIALLY_PAID],
        },
        dueDate: { lt: lateBefore },
      },
      select: { id: true, userId: true, dueDate: true },
    });
    if (newlyLate.length > 0) {
      await this.prisma.contribution.updateMany({
        where: { id: { in: newlyLate.map((r) => r.id) } },
        data: { status: ContributionStatus.LATE, lateMarkedAt: now },
      });
    }

    const rate = cfg.latePenaltyRate != null ? decN(cfg.latePenaltyRate) : 0;
    let finesIssued = 0;
    const fineByUser = new Map<string, { count: number; total: number }>();
    if (rate > 0) {
      // Includes LATE rows from before this job existed (repair), but never rows that were
      // due before the contribution rules were created.
      const unfined = await this.prisma.contribution.findMany({
        where: {
          groupId,
          status: ContributionStatus.LATE,
          fine: { is: null },
          dueDate: { gte: startOfUtcDay(cfg.createdAt) },
        },
        select: { id: true, userId: true, amount: true, dueDate: true },
      });
      if (unfined.length > 0) {
        const data = unfined.map((r) => {
          const amount = roundMoney(decN(r.amount) * (rate / 100));
          return {
            groupId,
            userId: r.userId,
            type: FineType.LATE_CONTRIBUTION,
            amount: dec(amount),
            currency: cfg.currency,
            reason: `Late contribution due ${r.dueDate.toISOString().slice(0, 10)} (${rate}% fine)`,
            status: FineStatus.OPEN,
            contributionId: r.id,
          };
        });
        const res = await this.prisma.fine.createMany({
          data: data.filter((d) => decN(d.amount) > 0),
          skipDuplicates: true,
        });
        finesIssued = res.count;
        for (const d of data) {
          const cur = fineByUser.get(d.userId) ?? { count: 0, total: 0 };
          cur.count += 1;
          cur.total = roundMoney(cur.total + decN(d.amount));
          fineByUser.set(d.userId, cur);
        }
      }
    }

    // One notification per member summarising what changed.
    const lateByUser = new Map<string, number>();
    for (const r of newlyLate) {
      lateByUser.set(r.userId, (lateByUser.get(r.userId) ?? 0) + 1);
    }
    const userIds = new Set([...lateByUser.keys(), ...fineByUser.keys()]);
    const notes: Parameters<
      NotificationsService['createMemberNotificationsBulk']
    >[0] = [];
    for (const userId of userIds) {
      const late = lateByUser.get(userId) ?? 0;
      const fine = fineByUser.get(userId);
      const parts: string[] = [];
      if (late > 0) {
        parts.push(
          `${late} contribution${late > 1 ? 's are' : ' is'} now late in ${cfg.group.name}.`,
        );
      }
      if (fine && fine.total > 0) {
        parts.push(
          `A late fine of ${fine.total.toFixed(0)} ${cfg.currency} was added.`,
        );
      }
      notes.push({
        userId,
        groupId,
        type: fine
          ? NotificationType.FINE_ISSUED
          : NotificationType.CONTRIBUTION_LATE,
        title: fine ? 'Late fine issued' : 'Contribution overdue',
        body: parts.join(' '),
        metadata: {
          groupName: cfg.group.name,
          lateCount: late,
          fineTotal: fine?.total ?? 0,
        },
      });
    }
    await this.notifications.createMemberNotificationsBulk(notes);

    return { rowsMarkedLate: newlyLate.length, finesIssued };
  }

  /** In-app reminder `reminderDaysBefore` days before each due date (once per row). */
  async sendDueReminders(groupId: string, now = new Date()) {
    const cfg = await this.prisma.contributionConfig.findUnique({
      where: { groupId },
      include: { group: { select: { name: true } } },
    });
    if (!cfg || cfg.reminderDaysBefore <= 0) return 0;
    const rows = await this.prisma.contribution.findMany({
      where: {
        groupId,
        status: {
          in: [ContributionStatus.PENDING, ContributionStatus.PARTIALLY_PAID],
        },
        reminderSentAt: null,
        dueDate: { gt: now, lte: addDays(now, cfg.reminderDaysBefore) },
      },
      select: {
        id: true,
        userId: true,
        amount: true,
        amountPaid: true,
        dueDate: true,
      },
    });
    if (rows.length === 0) return 0;
    await this.notifications.createMemberNotificationsBulk(
      rows.map((r) => {
        const left = roundMoney(decN(r.amount) - decN(r.amountPaid));
        const day = r.dueDate.toISOString().slice(0, 10);
        return {
          userId: r.userId,
          groupId,
          type: NotificationType.CONTRIBUTION_DUE_SOON,
          title: 'Contribution due soon',
          body: `Your ${left.toFixed(0)} ${cfg.currency} contribution to ${cfg.group.name} is due on ${day}.`,
          metadata: {
            groupName: cfg.group.name,
            contributionId: r.id,
            dueDate: day,
          },
        };
      }),
    );
    await this.prisma.contribution.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { reminderSentAt: now },
    });
    return rows.length;
  }

  /**
   * Config changed: drop future rows nobody has touched (no money, no fine), then regenerate.
   * History and partially paid rows are never modified.
   */
  async onConfigChanged(groupId: string, now = new Date()) {
    await this.prisma.contribution.deleteMany({
      where: {
        groupId,
        dueDate: { gt: now },
        status: ContributionStatus.PENDING,
        amountPaid: 0,
        allocations: { none: {} },
        fine: { is: null },
      },
    });
    return this.ensureGroupRows(groupId, now);
  }

  /** Full daily pass for one group. */
  async runForGroup(
    groupId: string,
    now = new Date(),
  ): Promise<ScheduleRunResult> {
    const rowsCreated = await this.ensureGroupRows(groupId, now);
    const { rowsMarkedLate, finesIssued } = await this.markLateAndIssueFines(
      groupId,
      now,
    );
    const remindersSent = await this.sendDueReminders(groupId, now);
    return { groupId, rowsCreated, rowsMarkedLate, finesIssued, remindersSent };
  }

  /** Groups the scheduler works on: verified, not deleted, with contribution rules. */
  async schedulableGroupIds(): Promise<string[]> {
    const rows = await this.prisma.contributionConfig.findMany({
      where: { group: { isVerified: true, deletedAt: null } },
      select: { groupId: true },
    });
    return rows.map((r) => r.groupId);
  }

  async runForAllGroups(now = new Date()) {
    const out: ScheduleRunResult[] = [];
    for (const groupId of await this.schedulableGroupIds()) {
      try {
        out.push(await this.runForGroup(groupId, now));
      } catch (e) {
        this.logger.error(
          `Contribution schedule failed for group ${groupId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return out;
  }
}
