import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CycleStatus,
  FineStatus,
  FundType,
  LedgerDirection,
  LedgerEntryType,
  MemberLoanStatus,
  NotificationType,
  Prisma,
  RoleName,
  ShareOutStatus,
} from '@prisma/client';
import { GroupCashService } from '../finance-core/group-cash.service';
import {
  LedgerInput,
  splitLoanRepayment,
  writeLedger,
} from '../finance-core/ledger';
import { EPS, dec, decN, roundMoney } from '../finance-core/money.util';
import { afterLoanPayment } from '../finance-core/loan-installments';
import { loanBalances } from '../finance-core/payment-allocation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountingAccessService } from './accounting-access.service';
import { computeShareOut } from './share-out.calculator';

type Db = Prisma.TransactionClient;

const dayStart = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    throw new BadRequestException(`Invalid date: ${iso}`);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
};
const dayEnd = (iso: string) =>
  new Date(dayStart(iso).getTime() + 86_400_000 - 1);

@Injectable()
export class CyclesService {
  private readonly logger = new Logger(CyclesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccountingAccessService,
    private readonly cash: GroupCashService,
    private readonly notifications: NotificationsService,
  ) {}

  private toDto(c: Prisma.GroupCycleGetPayload<object>) {
    return {
      id: c.id,
      groupId: c.groupId,
      name: c.name,
      startDate: c.startDate.toISOString(),
      endDate: c.endDate.toISOString(),
      status: c.status,
      preparedAt: c.preparedAt?.toISOString() ?? null,
      closedAt: c.closedAt?.toISOString() ?? null,
      closingSummary: c.closingSummary,
      notes: c.notes,
    };
  }

  async list(userId: string, groupId: string) {
    await this.access.member(userId, groupId);
    const rows = await this.prisma.groupCycle.findMany({
      where: { groupId },
      orderBy: { startDate: 'desc' },
    });
    return rows.map((c) => this.toDto(c));
  }

  private async loadCycle(
    groupId: string,
    cycleId: string,
    db: Db = this.prisma,
  ) {
    const c = await db.groupCycle.findFirst({
      where: { id: cycleId, groupId },
    });
    if (!c) throw new NotFoundException('Cycle not found.');
    return c;
  }

  private async assertNoOverlap(
    groupId: string,
    start: Date,
    end: Date,
    exceptId?: string,
  ) {
    const clash = await this.prisma.groupCycle.findFirst({
      where: {
        groupId,
        ...(exceptId ? { id: { not: exceptId } } : {}),
        startDate: { lte: end },
        endDate: { gte: start },
      },
    });
    if (clash) {
      throw new BadRequestException(
        `These dates overlap the cycle "${clash.name}".`,
      );
    }
  }

  /** Tag untagged rows whose date falls inside the cycle. */
  private async retag(c: {
    id: string;
    groupId: string;
    startDate: Date;
    endDate: Date;
  }) {
    const range = { gte: c.startDate, lte: c.endDate };
    const base = { groupId: c.groupId, cycleId: null };
    await this.prisma.$transaction([
      this.prisma.contribution.updateMany({
        where: { ...base, dueDate: range },
        data: { cycleId: c.id },
      }),
      this.prisma.fine.updateMany({
        where: { ...base, createdAt: range },
        data: { cycleId: c.id },
      }),
      this.prisma.memberLoan.updateMany({
        where: { ...base, disbursedAt: range },
        data: { cycleId: c.id },
      }),
      this.prisma.ledgerEntry.updateMany({
        where: { ...base, occurredAt: range },
        data: { cycleId: c.id },
      }),
      this.prisma.expense.updateMany({
        where: { ...base, occurredAt: range },
        data: { cycleId: c.id },
      }),
      this.prisma.socialPayout.updateMany({
        where: { ...base, createdAt: range },
        data: { cycleId: c.id },
      }),
      this.prisma.rotationSlot.updateMany({
        where: { ...base, dueDate: range },
        data: { cycleId: c.id },
      }),
    ]);
    // Contribution lines follow the cycle of the period they paid, not the payment date.
    await this.prisma.$executeRaw`
      UPDATE ledger_entries le SET "cycleId" = c."cycleId"
      FROM contributions c
      WHERE le."contributionId" = c.id AND le."groupId" = ${c.groupId}
        AND le.type = 'CONTRIBUTION' AND c."cycleId" = ${c.id}
        AND le."cycleId" IS DISTINCT FROM c."cycleId"`;
  }

  async create(
    userId: string,
    groupId: string,
    dto: { name: string; startDate: string; endDate: string; notes?: string },
  ) {
    await this.access.admin(userId, groupId, 'start a savings cycle');
    const start = dayStart(dto.startDate);
    const end = dayEnd(dto.endDate);
    if (end <= start)
      throw new BadRequestException(
        'The end date must be after the start date.',
      );
    const open = await this.prisma.groupCycle.findFirst({
      where: { groupId, status: { not: CycleStatus.CLOSED } },
    });
    if (open) {
      throw new BadRequestException(
        `Close the current cycle "${open.name}" before starting a new one.`,
      );
    }
    await this.assertNoOverlap(groupId, start, end);
    const c = await this.prisma.groupCycle.create({
      data: {
        groupId,
        name: dto.name.trim(),
        startDate: start,
        endDate: end,
        notes: dto.notes?.trim() || null,
      },
    });
    await this.retag(c);
    return this.toDto(c);
  }

  async update(
    userId: string,
    groupId: string,
    cycleId: string,
    dto: { name?: string; endDate?: string; notes?: string },
  ) {
    await this.access.admin(userId, groupId, 'edit a cycle');
    const c = await this.loadCycle(groupId, cycleId);
    if (c.status !== CycleStatus.ACTIVE) {
      throw new BadRequestException('Only an active cycle can be edited.');
    }
    const end = dto.endDate ? dayEnd(dto.endDate) : c.endDate;
    if (end <= c.startDate)
      throw new BadRequestException(
        'The end date must be after the start date.',
      );
    if (dto.endDate)
      await this.assertNoOverlap(groupId, c.startDate, end, c.id);
    if (end < c.endDate) {
      const later = await this.prisma.ledgerEntry.count({
        where: { cycleId: c.id, occurredAt: { gt: end } },
      });
      if (later > 0) {
        throw new BadRequestException(
          'Money was already recorded after the new end date.',
        );
      }
    }
    const updated = await this.prisma.groupCycle.update({
      where: { id: c.id },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes.trim() || null } : {}),
        endDate: end,
      },
    });
    await this.retag(updated);
    return this.toDto(updated);
  }

  private async reserved(
    groupId: string,
    exceptCycleId: string,
    db: Db = this.prisma,
  ) {
    const pos = await this.cash.getCashPosition(groupId, db);
    const thisCycle = await db.shareOut.aggregate({
      where: {
        cycleId: exceptCycleId,
        status: ShareOutStatus.PENDING,
        cycle: { status: CycleStatus.CLOSED },
      },
      _sum: { netPayout: true },
    });
    return {
      payouts: pos.reservedForPayouts,
      otherShareOuts: roundMoney(
        pos.reservedForShareOuts - decN(thisCycle._sum.netPayout),
      ),
    };
  }

  /** Live calculation (active / closing cycle) or the stored result (closed cycle). */
  /** `full`: every member line (share-out report, msfts §5); otherwise members see their own. */
  async shareOut(
    userId: string,
    groupId: string,
    cycleId: string,
    full = false,
  ) {
    const ctx = await this.access.member(userId, groupId);
    const seeAll = full || ctx.isLeader || ctx.isSuperAdmin;
    const c = await this.loadCycle(groupId, cycleId);
    if (c.status === CycleStatus.CLOSED) {
      const rows = await this.prisma.shareOut.findMany({
        where: { cycleId },
        orderBy: { grossAmount: 'desc' },
      });
      const users = await this.prisma.user.findMany({
        where: { id: { in: rows.map((r) => r.userId) } },
        select: { id: true, fullName: true },
      });
      const name = new Map(users.map((u) => [u.id, u.fullName]));
      const lines = rows
        .filter((r) => seeAll || r.userId === userId)
        .map((r) => ({
          id: r.id,
          userId: r.userId,
          fullName: name.get(r.userId) ?? 'Member',
          openingBalance: decN(r.openingBalance),
          savings: decN(r.savings),
          profitShare: decN(r.profitShare),
          grossAmount: decN(r.grossAmount),
          fineDeduction: decN(r.fineDeduction),
          loanDeduction: decN(r.loanDeduction),
          uncoveredDebt: decN(r.uncoveredDebt),
          netPayout: decN(r.netPayout),
          status: r.status,
          method: r.method,
          paidAt: r.paidAt?.toISOString() ?? null,
        }));
      return {
        cycle: this.toDto(c),
        final: true,
        totals: c.closingSummary,
        lines,
      };
    }
    const result = await computeShareOut(
      this.prisma,
      c,
      await this.reserved(groupId, c.id),
    );
    const lines = seeAll
      ? result.lines
      : result.lines.filter((l) => l.userId === userId);
    return { cycle: this.toDto(c), final: false, totals: result.totals, lines };
  }

  /** Treasurer or admin: freeze the cycle for review (no approval yet). */
  async prepare(userId: string, groupId: string, cycleId: string) {
    const ctx = await this.access.leader(
      userId,
      groupId,
      'prepare the share-out',
    );
    const c = await this.loadCycle(groupId, cycleId);
    if (c.status !== CycleStatus.ACTIVE)
      throw new BadRequestException('This cycle is not active.');
    const result = await computeShareOut(
      this.prisma,
      c,
      await this.reserved(groupId, c.id),
    );
    await this.prisma.$transaction(async (tx) => {
      await tx.shareOut.deleteMany({ where: { cycleId } });
      await tx.shareOut.createMany({
        data: result.lines.map((l) => this.shareOutRow(c, l)),
      });
      await tx.groupCycle.update({
        where: { id: cycleId },
        data: {
          status: CycleStatus.CLOSING,
          preparedAt: new Date(),
          preparedById: userId,
        },
      });
    });
    void this.notifications
      .notifyFinanceLeaders({
        groupId,
        type: NotificationType.SHARE_OUT_PREPARED,
        title: 'Share-out ready for approval',
        body: `The share-out of "${c.name}" in ${ctx.group.name} is prepared: ${result.totals.netPayout.toFixed(0)} RWF to pay out, net profit ${result.totals.netProfit.toFixed(0)} RWF.`,
        metadata: { groupName: ctx.group.name, cycleId },
        excludeUserId: userId,
      })
      .catch((e) => this.logger.error(e));
    return {
      cycle: this.toDto({ ...c, status: CycleStatus.CLOSING }),
      totals: result.totals,
      lines: result.lines,
    };
  }

  async cancelPreparation(userId: string, groupId: string, cycleId: string) {
    await this.access.leader(userId, groupId, 'reopen the cycle');
    const c = await this.loadCycle(groupId, cycleId);
    if (c.status !== CycleStatus.CLOSING)
      throw new BadRequestException('This cycle is not being closed.');
    await this.prisma.$transaction([
      this.prisma.shareOut.deleteMany({ where: { cycleId } }),
      this.prisma.groupCycle.update({
        where: { id: cycleId },
        data: {
          status: CycleStatus.ACTIVE,
          preparedAt: null,
          preparedById: null,
        },
      }),
    ]);
    return { id: cycleId, status: CycleStatus.ACTIVE };
  }

  private shareOutRow(
    c: { id: string; groupId: string },
    l: {
      userId: string;
      openingBalance: number;
      savings: number;
      profitShare: number;
      grossAmount: number;
      fineDeduction: number;
      loanDeduction: number;
      uncoveredDebt: number;
      netPayout: number;
    },
  ) {
    return {
      cycleId: c.id,
      groupId: c.groupId,
      userId: l.userId,
      openingBalance: dec(l.openingBalance),
      savings: dec(l.savings),
      profitShare: dec(l.profitShare),
      grossAmount: dec(l.grossAmount),
      fineDeduction: dec(l.fineDeduction),
      loanDeduction: dec(l.loanDeduction),
      uncoveredDebt: dec(l.uncoveredDebt),
      netPayout: dec(l.netPayout),
    };
  }

  /**
   * Second leader approves (one of the two must be the group admin): numbers are recomputed,
   * debts are settled from each member's share, the cycle closes and payouts become due.
   */
  async approve(userId: string, groupId: string, cycleId: string) {
    const ctx = await this.access.leader(
      userId,
      groupId,
      'approve the share-out',
    );
    const c = await this.loadCycle(groupId, cycleId);
    if (c.status !== CycleStatus.CLOSING) {
      throw new BadRequestException(
        'Prepare the share-out before approving it.',
      );
    }
    if (c.preparedById === userId) {
      throw new ForbiddenException(
        'The share-out must be approved by a different leader than the one who prepared it.',
      );
    }
    if (!ctx.isAdmin) {
      const preparer = await this.prisma.userGroup.findFirst({
        where: { groupId, userId: c.preparedById ?? '' },
        include: { role: true },
      });
      if (preparer?.role.name !== RoleName.GROUP_ADMIN) {
        throw new ForbiddenException(
          'The group admin must approve the share-out.',
        );
      }
    }

    const now = new Date();
    const result = await this.prisma.$transaction(
      async (tx) => {
        const res = await computeShareOut(
          tx,
          c,
          await this.reserved(groupId, c.id, tx),
        );
        if (res.totals.cashShortfall > EPS) {
          throw new BadRequestException(
            `The group is ${res.totals.cashShortfall.toFixed(0)} RWF short of what the share-out needs (${res.totals.uncoveredDebt.toFixed(0)} RWF of member debt is not covered by their shares). Collect outstanding loans or fines first.`,
          );
        }
        await tx.shareOut.deleteMany({ where: { cycleId } });
        for (const l of res.lines) {
          const so = await tx.shareOut.create({ data: this.shareOutRow(c, l) });
          await this.settleDebtsFromShare(
            tx,
            groupId,
            c.id,
            so.id,
            l,
            now,
            userId,
          );
        }
        await tx.groupCycle.update({
          where: { id: cycleId },
          data: {
            status: CycleStatus.CLOSED,
            closedAt: now,
            closedById: userId,
            closingSummary: res.totals as unknown as Prisma.InputJsonValue,
          },
        });
        return res;
      },
      { timeout: 60_000 },
    );

    await this.notifications.createMemberNotificationsBulk(
      result.lines.map((l) => ({
        userId: l.userId,
        groupId,
        type: NotificationType.CYCLE_CLOSED,
        title: 'Cycle closed — your share-out',
        body: `"${c.name}" in ${ctx.group.name} is closed. Your share: ${l.grossAmount.toFixed(0)} RWF (savings ${l.base.toFixed(0)} + profit ${l.profitShare.toFixed(0)})${l.fineDeduction + l.loanDeduction > EPS ? `, minus ${(l.fineDeduction + l.loanDeduction).toFixed(0)} RWF of debts` : ''} → ${l.netPayout.toFixed(0)} RWF to receive.`,
        metadata: {
          groupName: ctx.group.name,
          cycleId,
          netPayout: l.netPayout,
        },
      })),
    );
    return {
      cycle: this.toDto({ ...c, status: CycleStatus.CLOSED, closedAt: now }),
      totals: result.totals,
      lines: result.lines,
    };
  }

  /** Offset a member's open fines and loans against their share (cash-neutral ledger pairs). */
  private async settleDebtsFromShare(
    tx: Db,
    groupId: string,
    cycleId: string,
    shareOutId: string,
    l: { userId: string; fineDeduction: number; loanDeduction: number },
    now: Date,
    actorId: string,
  ) {
    const entries: LedgerInput[] = [];
    const pair = (
      key: string,
      type: LedgerEntryType,
      amount: number,
      refs: Partial<LedgerInput>,
    ) => {
      if (amount < EPS) return;
      const base = {
        groupId,
        cycleId,
        userId: l.userId,
        occurredAt: now,
        createdById: actorId,
        shareOutId,
        ...refs,
      };
      entries.push({
        ...base,
        type,
        direction: LedgerDirection.IN,
        amount,
        sourceKey: `shareout:${shareOutId}:${key}`,
        description: 'Settled from share-out',
      });
      entries.push({
        ...base,
        type: LedgerEntryType.SHARE_OUT,
        direction: LedgerDirection.OUT,
        amount,
        sourceKey: `shareout:${shareOutId}:${key}:offset`,
        description: 'Debt deducted from share-out',
      });
    };

    let fineLeft = l.fineDeduction;
    if (fineLeft > EPS) {
      const fines = await tx.fine.findMany({
        where: { groupId, userId: l.userId, status: FineStatus.OPEN },
        orderBy: { createdAt: 'asc' },
      });
      for (const f of fines) {
        if (fineLeft < EPS) break;
        const due = roundMoney(decN(f.amount) - decN(f.amountPaid));
        const pay = roundMoney(Math.min(due, fineLeft));
        const full = pay >= due - EPS;
        await tx.fine.update({
          where: { id: f.id },
          data: {
            amountPaid: dec(decN(f.amountPaid) + pay),
            ...(full ? { status: FineStatus.PAID, paidAt: now } : {}),
          },
        });
        pair(`fine:${f.id}`, LedgerEntryType.FINE, pay, { fineId: f.id });
        fineLeft = roundMoney(fineLeft - pay);
      }
    }

    let loanLeft = l.loanDeduction;
    if (loanLeft > EPS) {
      const loans = await tx.memberLoan.findMany({
        where: {
          groupId,
          userId: l.userId,
          status: { in: [MemberLoanStatus.ACTIVE, MemberLoanStatus.DEFAULTED] },
        },
        orderBy: { createdAt: 'asc' },
      });
      for (const loan of loans) {
        if (loanLeft < EPS) break;
        const { penalty, balance } = loanBalances(loan);
        const toPen = roundMoney(Math.min(loanLeft, penalty));
        loanLeft = roundMoney(loanLeft - toPen);
        const toBal = roundMoney(Math.min(loanLeft, balance));
        loanLeft = roundMoney(loanLeft - toBal);
        const newRepaid = roundMoney(decN(loan.amountRepaid) + toBal);
        const newPen = roundMoney(penalty - toPen);
        const cleared =
          newPen + Math.max(0, decN(loan.totalRepayable) - newRepaid) < EPS;
        await tx.memberLoan.update({
          where: { id: loan.id },
          data: {
            amountRepaid: dec(newRepaid),
            penaltyAccrued: dec(newPen),
            ...(cleared ? { status: MemberLoanStatus.REPAID } : {}),
          },
        });
        await afterLoanPayment(tx, loan.id, toBal, cleared, now);
        pair(`loan:${loan.id}:penalty`, LedgerEntryType.LOAN_PENALTY, toPen, {
          memberLoanId: loan.id,
        });
        const split = splitLoanRepayment(loan, toBal);
        pair(
          `loan:${loan.id}:principal`,
          LedgerEntryType.LOAN_PRINCIPAL,
          split.principal,
          { memberLoanId: loan.id },
        );
        pair(
          `loan:${loan.id}:interest`,
          LedgerEntryType.LOAN_INTEREST,
          split.interest,
          { memberLoanId: loan.id },
        );
      }
    }
    await writeLedger(tx, entries);
  }

  private async loadPayable(
    groupId: string,
    cycleId: string,
    shareOutId: string,
  ) {
    const c = await this.loadCycle(groupId, cycleId);
    if (c.status !== CycleStatus.CLOSED)
      throw new BadRequestException('Approve the share-out first.');
    const so = await this.prisma.shareOut.findFirst({
      where: { id: shareOutId, cycleId },
    });
    if (!so) throw new NotFoundException('Share-out line not found.');
    if (so.status !== ShareOutStatus.PENDING)
      throw new BadRequestException('This share-out was already settled.');
    return { c, so };
  }

  async pay(
    userId: string,
    groupId: string,
    cycleId: string,
    shareOutId: string,
    dto: { method: string; reference?: string },
  ) {
    const ctx = await this.access.leader(
      userId,
      groupId,
      'record share-out payments',
    );
    const { so } = await this.loadPayable(groupId, cycleId, shareOutId);
    if (so.userId === userId) {
      throw new ForbiddenException(
        'Another leader must record the payment of your own share-out.',
      );
    }
    await this.markPaid(so, userId, dto);
    void this.notifications
      .notifyMember({
        userId: so.userId,
        groupId,
        type: NotificationType.SHARE_OUT_PAID,
        title: 'Share-out paid',
        body: `Your share-out of ${decN(so.netPayout).toFixed(0)} RWF from ${ctx.group.name} was paid (${dto.method}).`,
        metadata: { groupName: ctx.group.name, cycleId, shareOutId },
      })
      .catch((e) => this.logger.error(e));
    return { id: shareOutId, status: ShareOutStatus.PAID };
  }

  private async markPaid(
    so: {
      id: string;
      groupId: string;
      cycleId: string;
      userId: string;
      netPayout: Prisma.Decimal;
    },
    actorId: string,
    dto: { method: string; reference?: string },
  ) {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.shareOut.updateMany({
        where: { id: so.id, status: ShareOutStatus.PENDING },
        data: {
          status: ShareOutStatus.PAID,
          paidAt: now,
          paidById: actorId,
          method: dto.method,
          reference: dto.reference?.trim() || null,
        },
      });
      if (claimed.count === 0)
        throw new BadRequestException('This share-out was already settled.');
      await writeLedger(tx, [
        {
          groupId: so.groupId,
          cycleId: so.cycleId,
          userId: so.userId,
          type: LedgerEntryType.SHARE_OUT,
          direction: LedgerDirection.OUT,
          amount: decN(so.netPayout),
          shareOutId: so.id,
          createdById: actorId,
          occurredAt: now,
          description: `Share-out paid (${dto.method})`,
          sourceKey: `shareout:${so.id}:paid`,
        },
      ]);
    });
  }

  /** Pay every pending line except the actor's own. */
  async payAll(
    userId: string,
    groupId: string,
    cycleId: string,
    dto: { method: string; reference?: string },
  ) {
    await this.access.leader(userId, groupId, 'record share-out payments');
    const c = await this.loadCycle(groupId, cycleId);
    if (c.status !== CycleStatus.CLOSED)
      throw new BadRequestException('Approve the share-out first.');
    const rows = await this.prisma.shareOut.findMany({
      where: {
        cycleId,
        status: ShareOutStatus.PENDING,
        userId: { not: userId },
      },
    });
    for (const so of rows) await this.markPaid(so, userId, dto);
    return { paid: rows.length };
  }

  /** Reinvest a member's net share as opening balance of the next (active) cycle. */
  async carryOver(
    userId: string,
    groupId: string,
    cycleId: string,
    shareOutId: string,
  ) {
    await this.access.leader(userId, groupId, 'carry share-outs over');
    const { so } = await this.loadPayable(groupId, cycleId, shareOutId);
    const next = await this.prisma.groupCycle.findFirst({
      where: { groupId, status: CycleStatus.ACTIVE },
    });
    if (!next)
      throw new BadRequestException(
        'Start the next cycle before carrying share-outs over.',
      );
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.shareOut.updateMany({
        where: { id: so.id, status: ShareOutStatus.PENDING },
        data: {
          status: ShareOutStatus.CARRIED_OVER,
          paidAt: now,
          paidById: userId,
          method: 'CARRY_OVER',
        },
      });
      if (claimed.count === 0)
        throw new BadRequestException('This share-out was already settled.');
      const amount = decN(so.netPayout);
      const base = {
        groupId,
        userId: so.userId,
        amount,
        shareOutId: so.id,
        createdById: userId,
        occurredAt: now,
      };
      await writeLedger(tx, [
        {
          ...base,
          cycleId: so.cycleId,
          type: LedgerEntryType.SHARE_OUT,
          direction: LedgerDirection.OUT,
          description: `Carried over to ${next.name}`,
          sourceKey: `shareout:${so.id}:carry`,
        },
        {
          ...base,
          cycleId: next.id,
          type: LedgerEntryType.OPENING_BALANCE,
          direction: LedgerDirection.IN,
          fund: FundType.SAVINGS,
          description: `Opening balance from previous cycle`,
          sourceKey: `shareout:${so.id}:opening`,
        },
      ]);
    });
    return {
      id: shareOutId,
      status: ShareOutStatus.CARRIED_OVER,
      nextCycleId: next.id,
    };
  }
}
