import { Injectable, Logger } from '@nestjs/common';
import {
  ContributionInterval,
  ContributionStatus,
  FineStatus,
  FineType,
  FundType,
  GroupMembershipStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { cycleResolver } from './ledger';
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

/** One schedule that generates periods: the savings rules or the social fund rules. */
interface ScheduleSource {
  fund: FundType;
  groupId: string;
  groupName: string;
  amount: Prisma.Decimal;
  currency: string;
  interval: ContributionInterval;
  startDate: Date;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  gracePeriodDays: number;
  latePenaltyRate: Prisma.Decimal | null;
  reminderDaysBefore: number;
  createdAt: Date;
}

const FUND_LABEL: Record<FundType, string> = {
  SAVINGS: 'contribution',
  SOCIAL: 'social fund contribution',
};

/**
 * Generates per-period `Contribution` rows from `ContributionConfig` (fund SAVINGS) and
 * `SocialFundConfig` (fund SOCIAL), marks rows LATE after dueDate + gracePeriodDays and issues
 * the late fine (frozen at the rate in force). Rows are tagged with their savings cycle.
 * Every operation is idempotent (unique userId+groupId+fund+dueDate, unique fine per row).
 */
@Injectable()
export class ContributionScheduleService {
  private readonly logger = new Logger(ContributionScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  static readonly OPEN_STATUSES = OPEN_STATUSES;

  /** Active schedules of a group (savings first). */
  async sources(
    groupId: string,
    db: Db = this.prisma,
  ): Promise<ScheduleSource[]> {
    const [cc, sf] = await Promise.all([
      db.contributionConfig.findUnique({
        where: { groupId },
        include: { group: { select: { name: true } } },
      }),
      db.socialFundConfig.findUnique({
        where: { groupId },
        include: { group: { select: { name: true } } },
      }),
    ]);
    const out: ScheduleSource[] = [];
    if (cc) {
      out.push({ ...cc, fund: FundType.SAVINGS, groupName: cc.group.name });
    }
    if (sf && sf.isActive) {
      out.push({ ...sf, fund: FundType.SOCIAL, groupName: sf.group.name });
    }
    return out;
  }

  private toSchedule(s: ScheduleSource): ScheduleConfig {
    return {
      interval: s.interval,
      startDate: s.startDate,
      dayOfWeek: s.dayOfWeek,
      dayOfMonth: s.dayOfMonth,
    };
  }

  /** Rows are generated up to now + one period so the upcoming period is always visible. */
  private horizon(s: ScheduleSource, now: Date): Date {
    return addDays(now, periodLengthDays(s.interval));
  }

  /** The per-member custom amount only applies to savings. */
  private memberAmount(
    s: ScheduleSource,
    custom: Prisma.Decimal | null | undefined,
  ): Prisma.Decimal {
    return s.fund === FundType.SAVINGS && custom != null && decN(custom) > 0
      ? custom
      : s.amount;
  }

  /** Create missing rows for every ACTIVE member of a group. Returns rows created. */
  async ensureGroupRows(
    groupId: string,
    now = new Date(),
    db: Db = this.prisma,
  ) {
    const sources = await this.sources(groupId, db);
    if (sources.length === 0) return 0;
    const members = await db.userGroup.findMany({
      where: { groupId, membershipStatus: GroupMembershipStatus.ACTIVE },
      select: { userId: true, joinedAt: true, customContributionAmount: true },
    });
    const cycleOf = await cycleResolver(db, groupId);
    let created = 0;
    for (const s of sources) {
      for (const m of members) {
        created += await this.ensureRowsForMember(db, s, m, now, cycleOf);
      }
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
    const sources = await this.sources(groupId, db);
    if (sources.length === 0) return 0;
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
    const cycleOf = await cycleResolver(db, groupId);
    let created = 0;
    for (const s of sources) {
      created += await this.ensureRowsForMember(db, s, m, now, cycleOf);
    }
    return created;
  }

  private async ensureRowsForMember(
    db: Db,
    s: ScheduleSource,
    m: {
      userId: string;
      joinedAt: Date;
      customContributionAmount: Prisma.Decimal | null;
    },
    now: Date,
    cycleOf: (d: Date) => string | null,
  ) {
    // Prorated from the join date: first period due on/after the day the member joined.
    const from = startOfUtcDay(m.joinedAt);
    const dates = dueDatesBetween(
      this.toSchedule(s),
      from,
      this.horizon(s, now),
    );
    if (dates.length === 0) return 0;
    const amount = this.memberAmount(s, m.customContributionAmount);
    const res = await db.contribution.createMany({
      data: dates.map((dueDate) => ({
        userId: m.userId,
        groupId: s.groupId,
        fund: s.fund,
        cycleId: cycleOf(dueDate),
        amount,
        dueDate,
        status: ContributionStatus.PENDING,
      })),
      skipDuplicates: true,
    });
    return res.count;
  }

  /**
   * Advance payment: create the member's next savings period after their latest one
   * (or their first period). Used when a deposit exceeds everything currently owed.
   */
  async createNextPeriodRow(db: Db, groupId: string, userId: string) {
    const s = (await this.sources(groupId, db)).find(
      (x) => x.fund === FundType.SAVINGS,
    );
    if (!s) return null;
    const m = await db.userGroup.findUnique({
      where: { userId_groupId: { userId, groupId } },
      select: { joinedAt: true, customContributionAmount: true },
    });
    const latest = await db.contribution.findFirst({
      where: { userId, groupId, fund: FundType.SAVINGS },
      orderBy: { dueDate: 'desc' },
      select: { dueDate: true },
    });
    const after = latest
      ? latest.dueDate
      : new Date(startOfUtcDay(m?.joinedAt ?? new Date()).getTime() - 1);
    const dueDate = firstDueAfter(this.toSchedule(s), after);
    const cycleOf = await cycleResolver(db, groupId);
    return db.contribution.create({
      data: {
        userId,
        groupId,
        fund: FundType.SAVINGS,
        cycleId: cycleOf(dueDate),
        amount: this.memberAmount(s, m?.customContributionAmount),
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
    const sources = await this.sources(groupId);
    const cycleOf = await cycleResolver(this.prisma, groupId);
    const lateByUser = new Map<string, number>();
    const fineByUser = new Map<string, { count: number; total: number }>();
    let rowsMarkedLate = 0;
    let finesIssued = 0;

    for (const s of sources) {
      const lateBefore = addDays(now, -s.gracePeriodDays);
      const newlyLate = await this.prisma.contribution.findMany({
        where: {
          groupId,
          fund: s.fund,
          status: {
            in: [ContributionStatus.PENDING, ContributionStatus.PARTIALLY_PAID],
          },
          dueDate: { lt: lateBefore },
        },
        select: { id: true, userId: true },
      });
      if (newlyLate.length > 0) {
        await this.prisma.contribution.updateMany({
          where: { id: { in: newlyLate.map((r) => r.id) } },
          data: { status: ContributionStatus.LATE, lateMarkedAt: now },
        });
        rowsMarkedLate += newlyLate.length;
        for (const r of newlyLate) {
          lateByUser.set(r.userId, (lateByUser.get(r.userId) ?? 0) + 1);
        }
      }

      const rate = s.latePenaltyRate != null ? decN(s.latePenaltyRate) : 0;
      if (rate <= 0) continue;
      // Includes LATE rows from before this job existed (repair), but never rows that were
      // due before the rules were created.
      const unfined = await this.prisma.contribution.findMany({
        where: {
          groupId,
          fund: s.fund,
          status: ContributionStatus.LATE,
          fine: { is: null },
          dueDate: { gte: startOfUtcDay(s.createdAt) },
        },
        select: { id: true, userId: true, amount: true, dueDate: true },
      });
      if (unfined.length === 0) continue;
      const data = unfined
        .map((r) => ({
          groupId,
          userId: r.userId,
          type: FineType.LATE_CONTRIBUTION,
          amount: dec(roundMoney(decN(r.amount) * (rate / 100))),
          currency: s.currency,
          reason: `Late ${FUND_LABEL[s.fund]} due ${r.dueDate.toISOString().slice(0, 10)} (${rate}% fine)`,
          status: FineStatus.OPEN,
          contributionId: r.id,
          cycleId: cycleOf(now),
        }))
        .filter((d) => decN(d.amount) > 0);
      const res = await this.prisma.fine.createMany({
        data,
        skipDuplicates: true,
      });
      finesIssued += res.count;
      for (const d of data) {
        const cur = fineByUser.get(d.userId) ?? { count: 0, total: 0 };
        cur.count += 1;
        cur.total = roundMoney(cur.total + decN(d.amount));
        fineByUser.set(d.userId, cur);
      }
    }

    // One notification per member summarising what changed.
    const groupName = sources[0]?.groupName ?? 'your group';
    const currency = sources[0]?.currency ?? 'RWF';
    const notes: Parameters<
      NotificationsService['createMemberNotificationsBulk']
    >[0] = [];
    for (const userId of new Set([
      ...lateByUser.keys(),
      ...fineByUser.keys(),
    ])) {
      const late = lateByUser.get(userId) ?? 0;
      const fine = fineByUser.get(userId);
      const parts: string[] = [];
      if (late > 0) {
        parts.push(
          `${late} contribution${late > 1 ? 's are' : ' is'} now late in ${groupName}.`,
        );
      }
      if (fine && fine.total > 0) {
        parts.push(
          `A late fine of ${fine.total.toFixed(0)} ${currency} was added.`,
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
        metadata: { groupName, lateCount: late, fineTotal: fine?.total ?? 0 },
      });
    }
    await this.notifications.createMemberNotificationsBulk(notes);
    return { rowsMarkedLate, finesIssued };
  }

  /** In-app reminder `reminderDaysBefore` days before each due date (once per row). */
  async sendDueReminders(groupId: string, now = new Date()) {
    let sent = 0;
    for (const s of await this.sources(groupId)) {
      if (s.reminderDaysBefore <= 0) continue;
      const rows = await this.prisma.contribution.findMany({
        where: {
          groupId,
          fund: s.fund,
          status: {
            in: [ContributionStatus.PENDING, ContributionStatus.PARTIALLY_PAID],
          },
          reminderSentAt: null,
          dueDate: { gt: now, lte: addDays(now, s.reminderDaysBefore) },
        },
        select: {
          id: true,
          userId: true,
          amount: true,
          amountPaid: true,
          dueDate: true,
        },
      });
      if (rows.length === 0) continue;
      await this.notifications.createMemberNotificationsBulk(
        rows.map((r) => {
          const left = roundMoney(decN(r.amount) - decN(r.amountPaid));
          const day = r.dueDate.toISOString().slice(0, 10);
          return {
            userId: r.userId,
            groupId,
            type: NotificationType.CONTRIBUTION_DUE_SOON,
            title:
              s.fund === FundType.SOCIAL
                ? 'Social fund contribution due soon'
                : 'Contribution due soon',
            body: `Your ${left.toFixed(0)} ${s.currency} ${FUND_LABEL[s.fund]} to ${s.groupName} is due on ${day}.`,
            metadata: {
              groupName: s.groupName,
              contributionId: r.id,
              dueDate: day,
              fund: s.fund,
            },
          };
        }),
      );
      await this.prisma.contribution.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { reminderSentAt: now },
      });
      sent += rows.length;
    }
    return sent;
  }

  /**
   * Rules changed: drop future rows of that fund nobody has touched (no money, no fine), then
   * regenerate. History and partially paid rows are never modified.
   */
  async onConfigChanged(
    groupId: string,
    now = new Date(),
    fund: FundType = FundType.SAVINGS,
  ) {
    await this.prisma.contribution.deleteMany({
      where: {
        groupId,
        fund,
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

  /** Groups the scheduler works on: verified, not deleted, with contribution or social rules. */
  async schedulableGroupIds(): Promise<string[]> {
    const live = { group: { isVerified: true, deletedAt: null } };
    const [a, b] = await Promise.all([
      this.prisma.contributionConfig.findMany({
        where: live,
        select: { groupId: true },
      }),
      this.prisma.socialFundConfig.findMany({
        where: { ...live, isActive: true },
        select: { groupId: true },
      }),
    ]);
    return [...new Set([...a, ...b].map((r) => r.groupId))];
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
