import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  GroupMembershipStatus,
  NotificationAudience,
  NotificationChannel,
  NotificationType,
  RoleName,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationDeliveryService,
  type DeliveryItem,
} from './delivery.service';
import { MANDATORY_IN_APP } from './notification-catalog';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  /**
   * Inserts the in-app rows (skipping users who muted the category in the app) and hands
   * every recipient to the delivery service for email / SMS / push (msfts §7).
   */
  private async insertAndDeliver(
    rows: {
      userId: string;
      groupId: string | null;
      type: NotificationType;
      audience: NotificationAudience;
      title: string;
      body: string;
      metadata?: object | null;
    }[],
    opts: { onlyChannels?: NotificationChannel[] } = {},
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const muted = new Set<string>();
    for (const type of new Set(rows.map((r) => r.type))) {
      if (MANDATORY_IN_APP.has(type)) continue;
      const ids = rows.filter((r) => r.type === type).map((r) => r.userId);
      for (const id of await this.delivery.inAppMuted(ids, type)) {
        muted.add(`${type}:${id}`);
      }
    }
    const visible = rows.filter((r) => !muted.has(`${r.type}:${r.userId}`));
    let created: { id: string; userId: string; type: NotificationType }[] = [];
    try {
      created = visible.length
        ? await this.prisma.userNotification.createManyAndReturn({
            data: visible.map((r) => ({
              userId: r.userId,
              groupId: r.groupId,
              type: r.type,
              audience: r.audience,
              title: r.title,
              body: r.body,
              ...(r.metadata != null && { metadata: r.metadata }),
            })),
            select: { id: true, userId: true, type: true },
          })
        : [];
    } catch (e) {
      this.logger.error(
        `userNotification insert failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // RETURNING keeps insertion order, so created[i] belongs to visible[i].
    const idOf = new Map<object, string>();
    visible.forEach((r, i) => {
      const c = created[i];
      if (c && c.userId === r.userId && c.type === r.type) idOf.set(r, c.id);
    });
    const items: DeliveryItem[] = rows.map((r) => ({
      id: idOf.get(r) ?? null,
      userId: r.userId,
      groupId: r.groupId,
      type: r.type,
      title: r.title,
      body: r.body,
      metadata: r.metadata,
    }));
    void this.delivery.dispatch(items, opts);
    return created.length;
  }

  private async userIdsByRoles(
    groupId: string,
    roles: RoleName[],
  ): Promise<string[]> {
    const rows = await this.prisma.userGroup.findMany({
      where: {
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
        role: { name: { in: roles } },
      },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }

  private async createMany(
    userIds: string[],
    row: {
      groupId: string | null;
      type: NotificationType;
      audience: NotificationAudience;
      title: string;
      body: string;
      metadata?: object | null;
    },
  ) {
    await this.insertAndDeliver(
      [...new Set(userIds)].map((userId) => ({ userId, ...row })),
    );
  }

  private async createOne(
    userId: string,
    row: {
      groupId: string | null;
      type: NotificationType;
      audience: NotificationAudience;
      title: string;
      body: string;
      metadata?: object | null;
    },
  ) {
    await this.createMany([userId], row);
  }

  /** Manual transfer submitted — all group admins and treasurers. */
  async notifyManualDepositPending(p: {
    groupId: string;
    groupName: string;
    depositId: string;
    amount: string;
    currency: string;
    memberName: string;
    isLoanRepayment: boolean;
  }) {
    const admins = await this.userIdsByRoles(p.groupId, [RoleName.GROUP_ADMIN]);
    const treasurers = await this.userIdsByRoles(p.groupId, [
      RoleName.TREASURER,
    ]);
    const type = NotificationType.DEPOSIT_MANUAL_PENDING;
    const title = p.isLoanRepayment
      ? 'Loan repayment proof to review'
      : 'Payment proof to review';
    const body = p.isLoanRepayment
      ? `${p.memberName} submitted a loan repayment transfer (${p.amount} ${p.currency}) in ${p.groupName}.`
      : `${p.memberName} submitted a bank transfer proof (${p.amount} ${p.currency}) in ${p.groupName}.`;
    const meta = {
      groupName: p.groupName,
      depositId: p.depositId,
      amount: p.amount,
      currency: p.currency,
    };
    await this.createMany(admins, {
      groupId: p.groupId,
      type,
      audience: NotificationAudience.GROUP_ADMIN,
      title,
      body,
      metadata: meta,
    });
    await this.createMany(treasurers, {
      groupId: p.groupId,
      type,
      audience: NotificationAudience.TREASURER,
      title,
      body,
      metadata: meta,
    });
  }

  /** MoMo or instant confirmation — member receipt. */
  async notifyMemberDepositRecorded(p: {
    userId: string;
    groupId: string;
    groupName: string;
    amount: string;
    currency: string;
  }) {
    await this.createOne(p.userId, {
      groupId: p.groupId,
      type: NotificationType.DEPOSIT_RECORDED,
      audience: NotificationAudience.MEMBER,
      title: 'Payment recorded',
      body: `Your ${p.amount} ${p.currency} payment was applied in ${p.groupName}.`,
      metadata: {
        groupName: p.groupName,
        amount: p.amount,
        currency: p.currency,
      },
    });
  }

  async notifyMemberLoanRepaymentRecorded(p: {
    userId: string;
    groupId: string;
    groupName: string;
    amount: string;
    currency: string;
  }) {
    await this.createOne(p.userId, {
      groupId: p.groupId,
      type: NotificationType.LOAN_REPAYMENT_RECORDED,
      audience: NotificationAudience.MEMBER,
      title: 'Loan payment recorded',
      body: `Your ${p.amount} ${p.currency} loan payment was applied in ${p.groupName}.`,
      metadata: {
        groupName: p.groupName,
        amount: p.amount,
        currency: p.currency,
      },
    });
  }

  async notifyMemberManualDepositConfirmed(p: {
    userId: string;
    groupId: string;
    groupName: string;
    amount: string;
    currency: string;
    isLoan: boolean;
  }) {
    const type = p.isLoan
      ? NotificationType.LOAN_REPAYMENT_APPLIED
      : NotificationType.DEPOSIT_CONFIRMED;
    const title = p.isLoan ? 'Loan repayment confirmed' : 'Payment confirmed';
    const body = p.isLoan
      ? `Your loan repayment of ${p.amount} ${p.currency} was confirmed in ${p.groupName}.`
      : `Your payment of ${p.amount} ${p.currency} was confirmed in ${p.groupName}.`;
    await this.createOne(p.userId, {
      groupId: p.groupId,
      type,
      audience: NotificationAudience.MEMBER,
      title,
      body,
      metadata: {
        groupName: p.groupName,
        amount: p.amount,
        currency: p.currency,
      },
    });
  }

  async notifyMemberDepositRejected(p: {
    userId: string;
    groupId: string;
    groupName: string;
    amount: string;
    currency: string;
    reason: string | null;
  }) {
    const reason = p.reason?.trim() || 'No reason given.';
    await this.createOne(p.userId, {
      groupId: p.groupId,
      type: NotificationType.DEPOSIT_REJECTED,
      audience: NotificationAudience.MEMBER,
      title: 'Payment not accepted',
      body: `Your ${p.amount} ${p.currency} transfer in ${p.groupName} was not accepted. ${reason}`,
      metadata: { groupName: p.groupName, reason },
    });
  }

  /** Leadership audit when another admin confirms. */
  async notifyAuditManualConfirm(p: {
    groupId: string;
    groupName: string;
    amount: string;
    currency: string;
    memberName: string;
    excludeUserId: string;
  }) {
    const allAdmins = await this.userIdsByRoles(p.groupId, [
      RoleName.GROUP_ADMIN,
    ]);
    const treasurers = await this.userIdsByRoles(p.groupId, [
      RoleName.TREASURER,
    ]);
    const others = [
      ...new Set(
        [...allAdmins, ...treasurers].filter((id) => id !== p.excludeUserId),
      ),
    ];
    for (const uid of others) {
      const aud: NotificationAudience = allAdmins.includes(uid)
        ? NotificationAudience.GROUP_ADMIN
        : NotificationAudience.TREASURER;
      await this.createOne(uid, {
        groupId: p.groupId,
        type: NotificationType.MANUAL_DEPOSIT_AUDIT_CONFIRM,
        audience: aud,
        title: 'Manual payment confirmed',
        body: `A ${p.amount} ${p.currency} transfer from ${p.memberName} was confirmed in ${p.groupName}.`,
        metadata: { groupName: p.groupName },
      });
    }
  }

  async notifyAuditManualReject(p: {
    groupId: string;
    groupName: string;
    amount: string;
    currency: string;
    memberName: string;
    excludeUserId: string;
  }) {
    const allAdmins = await this.userIdsByRoles(p.groupId, [
      RoleName.GROUP_ADMIN,
    ]);
    const treasurers = await this.userIdsByRoles(p.groupId, [
      RoleName.TREASURER,
    ]);
    const others = [
      ...new Set(
        [...allAdmins, ...treasurers].filter((id) => id !== p.excludeUserId),
      ),
    ];
    for (const uid of others) {
      const aud: NotificationAudience = allAdmins.includes(uid)
        ? NotificationAudience.GROUP_ADMIN
        : NotificationAudience.TREASURER;
      await this.createOne(uid, {
        groupId: p.groupId,
        type: NotificationType.MANUAL_DEPOSIT_AUDIT_REJECT,
        audience: aud,
        title: 'Manual payment rejected',
        body: `A ${p.amount} ${p.currency} transfer from ${p.memberName} was rejected in ${p.groupName}.`,
        metadata: { groupName: p.groupName },
      });
    }
  }

  async notifyLoanApplicationSubmitted(p: {
    groupId: string;
    groupName: string;
    applicationId: string;
    applicantUserId: string;
    applicantName: string;
    amount: string;
  }) {
    await this.createOne(p.applicantUserId, {
      groupId: p.groupId,
      type: NotificationType.LOAN_APPLICATION_SUBMITTED,
      audience: NotificationAudience.MEMBER,
      title: 'Loan request received',
      body: `We received your request for ${p.amount} RWF in ${p.groupName}. A group admin and the treasurer must both approve before disbursement.`,
      metadata: {
        groupName: p.groupName,
        applicationId: p.applicationId,
        amount: p.amount,
      },
    });
    const admins = await this.userIdsByRoles(p.groupId, [RoleName.GROUP_ADMIN]);
    const treasurers = await this.userIdsByRoles(p.groupId, [
      RoleName.TREASURER,
    ]);
    await this.createMany(
      admins.filter((id) => id !== p.applicantUserId),
      {
        groupId: p.groupId,
        type: NotificationType.LOAN_APPLICATION_SUBMITTED,
        audience: NotificationAudience.GROUP_ADMIN,
        title: 'New loan application',
        body: `${p.applicantName} applied for a ${p.amount} RWF loan in ${p.groupName}. Your approval may be required.`,
        metadata: { applicationId: p.applicationId, groupName: p.groupName },
      },
    );
    await this.createMany(
      treasurers.filter((id) => id !== p.applicantUserId),
      {
        groupId: p.groupId,
        type: NotificationType.LOAN_APPLICATION_SUBMITTED,
        audience: NotificationAudience.TREASURER,
        title: 'New loan application',
        body: `${p.applicantName} applied for a ${p.amount} RWF loan in ${p.groupName}. Your approval may be required.`,
        metadata: { applicationId: p.applicationId, groupName: p.groupName },
      },
    );
  }

  /** One side approved — notify the other role. */
  async notifyLoanAwaitingOtherApprover(p: {
    groupId: string;
    groupName: string;
    applicationId: string;
    applicantName: string;
    amount: string;
    justApprovedRole: 'GROUP_ADMIN' | 'TREASURER';
  }) {
    if (p.justApprovedRole === 'GROUP_ADMIN') {
      const treasurers = await this.userIdsByRoles(p.groupId, [
        RoleName.TREASURER,
      ]);
      await this.createMany(treasurers, {
        groupId: p.groupId,
        type: NotificationType.LOAN_AWAITING_YOUR_APPROVAL,
        audience: NotificationAudience.TREASURER,
        title: 'Loan needs treasurer approval',
        body: `Group admin approved ${p.applicantName}’s ${p.amount} RWF loan in ${p.groupName}. Your approval is still required to disburse.`,
        metadata: { applicationId: p.applicationId, groupName: p.groupName },
      });
    } else {
      const admins = await this.userIdsByRoles(p.groupId, [
        RoleName.GROUP_ADMIN,
      ]);
      await this.createMany(admins, {
        groupId: p.groupId,
        type: NotificationType.LOAN_AWAITING_YOUR_APPROVAL,
        audience: NotificationAudience.GROUP_ADMIN,
        title: 'Loan needs admin approval',
        body: `Treasurer approved ${p.applicantName}’s ${p.amount} RWF loan in ${p.groupName}. A group admin must still approve to disburse.`,
        metadata: { applicationId: p.applicationId, groupName: p.groupName },
      });
    }
  }

  async notifyLoanDisbursed(p: {
    borrowerUserId: string;
    groupId: string;
    groupName: string;
    amount: string;
    memberLoanId: string;
  }) {
    await this.createOne(p.borrowerUserId, {
      groupId: p.groupId,
      type: NotificationType.LOAN_DISBURSED,
      audience: NotificationAudience.MEMBER,
      title: 'Loan disbursed',
      body: `Your ${p.amount} RWF loan in ${p.groupName} is now active. Repay on schedule to avoid penalties.`,
      metadata: { memberLoanId: p.memberLoanId, groupName: p.groupName },
    });
  }

  async notifyLoanRejected(p: {
    borrowerUserId: string;
    groupId: string;
    groupName: string;
    reason: string;
  }) {
    await this.createOne(p.borrowerUserId, {
      groupId: p.groupId,
      type: NotificationType.LOAN_REJECTED,
      audience: NotificationAudience.MEMBER,
      title: 'Loan request declined',
      body: `Your loan request in ${p.groupName} was declined. ${p.reason}`,
      metadata: { groupName: p.groupName },
    });
  }

  /** Depositor: proof received, awaiting review. */
  async notifyMemberPaymentProofSubmitted(p: {
    userId: string;
    groupId: string;
    groupName: string;
    amount: string;
    currency: string;
    isLoanRepayment: boolean;
  }) {
    await this.createOne(p.userId, {
      groupId: p.groupId,
      type: NotificationType.PAYMENT_PROOF_SUBMITTED,
      audience: NotificationAudience.MEMBER,
      title: p.isLoanRepayment
        ? 'Loan repayment received'
        : 'Payment proof received',
      body: p.isLoanRepayment
        ? `We received your ${p.amount} ${p.currency} loan repayment proof in ${p.groupName}. A group admin or treasurer will review it.`
        : `We received your ${p.amount} ${p.currency} transfer proof in ${p.groupName}. A group admin or treasurer will review it.`,
      metadata: { groupName: p.groupName },
    });
  }

  /** Member: added to a group (admin invited an existing user). */
  async notifyUserAddedToGroup(p: {
    userId: string;
    groupId: string;
    groupName: string;
    context: 'invited' | 'joined';
  }) {
    const body =
      p.context === 'joined'
        ? `You’ve joined “${p.groupName}”. You can now contribute, request loans, and use group finance features when enabled.`
        : `You were added to “${p.groupName}”. You can now participate in the group.`;
    await this.createOne(p.userId, {
      groupId: p.groupId,
      type: NotificationType.ADDED_TO_GROUP,
      audience: NotificationAudience.MEMBER,
      title:
        p.context === 'joined'
          ? 'Welcome to the group'
          : 'You were added to a group',
      body,
      metadata: { groupName: p.groupName, context: p.context },
    });
  }

  /** Pending user created for email invite; shows in-app when they complete registration. */
  async notifyPendingInvitationStored(p: {
    userId: string;
    groupId: string;
    groupName: string;
  }) {
    await this.createOne(p.userId, {
      groupId: p.groupId,
      type: NotificationType.GROUP_INVITATION_PENDING,
      audience: NotificationAudience.MEMBER,
      title: 'You’re invited to a group',
      body: `You were invited to “${p.groupName}”. Complete registration and email verification, then you’ll have access.`,
      metadata: { groupName: p.groupName },
    });
  }

  /** Admins + treasurers: someone new in the team. */
  async notifyLeadersNewMember(p: {
    groupId: string;
    groupName: string;
    memberName: string;
    memberUserId: string;
    how: 'invited' | 'joined';
  }) {
    const howText =
      p.how === 'joined'
        ? 'joined the group'
        : 'was added to the group by an admin';
    const body = `${p.memberName} ${howText} in “${p.groupName}”.`;
    const admins = await this.userIdsByRoles(p.groupId, [RoleName.GROUP_ADMIN]);
    const treasurers = await this.userIdsByRoles(p.groupId, [
      RoleName.TREASURER,
    ]);
    const title =
      p.how === 'joined' ? 'New group member' : 'New member in your group';
    const meta = {
      groupName: p.groupName,
      memberUserId: p.memberUserId,
      how: p.how,
    };
    await this.createMany(
      admins.filter((id) => id !== p.memberUserId),
      {
        groupId: p.groupId,
        type: NotificationType.NEW_GROUP_MEMBER,
        audience: NotificationAudience.GROUP_ADMIN,
        title,
        body,
        metadata: meta,
      },
    );
    await this.createMany(
      treasurers.filter((id) => id !== p.memberUserId),
      {
        groupId: p.groupId,
        type: NotificationType.NEW_GROUP_MEMBER,
        audience: NotificationAudience.TREASURER,
        title,
        body,
        metadata: meta,
      },
    );
  }

  /** Generic: one notification to one member (audience MEMBER). */
  async notifyMember(p: {
    userId: string;
    groupId: string | null;
    type: NotificationType;
    title: string;
    body: string;
    metadata?: object | null;
  }) {
    await this.createOne(p.userId, {
      groupId: p.groupId,
      type: p.type,
      audience: NotificationAudience.MEMBER,
      title: p.title,
      body: p.body,
      metadata: p.metadata,
    });
  }

  /** Generic: all active group admins and treasurers (optionally excluding one user). */
  async notifyFinanceLeaders(p: {
    groupId: string;
    type: NotificationType;
    title: string;
    body: string;
    metadata?: object | null;
    excludeUserId?: string;
  }) {
    const admins = (
      await this.userIdsByRoles(p.groupId, [RoleName.GROUP_ADMIN])
    ).filter((id) => id !== p.excludeUserId);
    const treasurers = (
      await this.userIdsByRoles(p.groupId, [RoleName.TREASURER])
    ).filter((id) => id !== p.excludeUserId && !admins.includes(id));
    const base = {
      groupId: p.groupId,
      type: p.type,
      title: p.title,
      body: p.body,
      metadata: p.metadata,
    };
    await this.createMany(admins, {
      ...base,
      audience: NotificationAudience.GROUP_ADMIN,
    });
    await this.createMany(treasurers, {
      ...base,
      audience: NotificationAudience.TREASURER,
    });
  }

  /** Generic: only the group admins of a group. */
  async notifyGroupAdmins(p: {
    groupId: string;
    type: NotificationType;
    title: string;
    body: string;
    metadata?: object | null;
  }) {
    const admins = await this.userIdsByRoles(p.groupId, [RoleName.GROUP_ADMIN]);
    await this.createMany(admins, {
      groupId: p.groupId,
      type: p.type,
      audience: NotificationAudience.GROUP_ADMIN,
      title: p.title,
      body: p.body,
      metadata: p.metadata,
    });
  }

  /** Generic: every active platform super admin. */
  async notifySuperAdmins(p: {
    groupId: string | null;
    type: NotificationType;
    title: string;
    body: string;
    metadata?: object | null;
  }) {
    const rows = await this.prisma.userPlatformRole.findMany({
      where: { role: { name: RoleName.SUPER_ADMIN }, user: { isActive: true } },
      select: { userId: true },
    });
    await this.createMany(
      rows.map((r) => r.userId),
      {
        groupId: p.groupId,
        type: p.type,
        audience: NotificationAudience.SUPER_ADMIN,
        title: p.title,
        body: p.body,
        metadata: p.metadata,
      },
    );
  }

  /** Generic: every active member of a group (audience MEMBER), optionally excluding one. */
  async notifyAllMembers(p: {
    groupId: string;
    type: NotificationType;
    title: string;
    body: string;
    metadata?: object | null;
    excludeUserId?: string;
  }) {
    const rows = await this.prisma.userGroup.findMany({
      where: {
        groupId: p.groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
        ...(p.excludeUserId ? { userId: { not: p.excludeUserId } } : {}),
      },
      select: { userId: true },
    });
    await this.createMany(
      rows.map((r) => r.userId),
      {
        groupId: p.groupId,
        type: p.type,
        audience: NotificationAudience.MEMBER,
        title: p.title,
        body: p.body,
        metadata: p.metadata,
      },
    );
  }

  /** Bulk insert of pre-built member notifications (scheduler). */
  async createMemberNotificationsBulk(
    rows: {
      userId: string;
      groupId: string;
      type: NotificationType;
      title: string;
      body: string;
      metadata?: object | null;
    }[],
  ) {
    await this.insertAndDeliver(
      rows.map((r) => ({ ...r, audience: NotificationAudience.MEMBER })),
    );
  }

  /** Group announcement to every active member (msfts §7). Returns recipients. */
  async broadcastToGroup(p: {
    groupId: string;
    type: NotificationType;
    title: string;
    body: string;
    metadata?: object | null;
    extraChannels: NotificationChannel[];
  }): Promise<number> {
    const members = await this.prisma.userGroup.findMany({
      where: {
        groupId: p.groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
      },
      select: { userId: true },
    });
    await this.insertAndDeliver(
      members.map((m) => ({
        userId: m.userId,
        groupId: p.groupId,
        type: p.type,
        audience: NotificationAudience.MEMBER,
        title: p.title,
        body: p.body,
        metadata: p.metadata,
      })),
      { onlyChannels: p.extraChannels },
    );
    return members.length;
  }

  /** Removal / suspension / reactivation notice to the member concerned. */
  async notifyMembershipChange(p: {
    userId: string;
    groupId: string;
    groupName: string;
    kind: 'REMOVED' | 'SUSPENDED' | 'REACTIVATED';
    reason?: string;
  }) {
    const type =
      p.kind === 'REMOVED'
        ? NotificationType.REMOVED_FROM_GROUP
        : p.kind === 'SUSPENDED'
          ? NotificationType.SUSPENDED_IN_GROUP
          : NotificationType.MEMBERSHIP_REACTIVATED;
    const title =
      p.kind === 'REMOVED'
        ? `Removed from ${p.groupName}`
        : p.kind === 'SUSPENDED'
          ? `Suspended in ${p.groupName}`
          : `Welcome back to ${p.groupName}`;
    await this.insertAndDeliver([
      {
        userId: p.userId,
        groupId: p.groupId,
        type,
        audience: NotificationAudience.MEMBER,
        title,
        body: p.reason ?? 'Your membership is active again.',
        metadata: {
          groupName: p.groupName,
          kind: p.kind,
          reason: p.reason ?? null,
        },
      },
    ]);
  }

  /** Former GroupRemovalNotification list, now read from UserNotification. */
  async listMembershipNotices(userId: string) {
    const rows = await this.prisma.userNotification.findMany({
      where: {
        userId,
        type: {
          in: [
            NotificationType.REMOVED_FROM_GROUP,
            NotificationType.SUSPENDED_IN_GROUP,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => {
      const m = (r.metadata ?? {}) as { groupName?: string; reason?: string };
      return {
        id: r.id,
        groupId: r.groupId ?? '',
        groupName:
          m.groupName ?? r.title.replace(/^(Removed from|Suspended in) /, ''),
        kind:
          r.type === NotificationType.REMOVED_FROM_GROUP
            ? 'REMOVED'
            : 'SUSPENDED',
        reason: m.reason ?? r.body,
        readAt: r.readAt,
        createdAt: r.createdAt,
      };
    });
  }

  async listForUser(
    userId: string,
    q: {
      audience?: NotificationAudience;
      groupId?: string;
      unreadOnly?: boolean;
      limit?: number;
    },
  ) {
    const limit = Math.min(q.limit ?? 50, 100);
    return this.prisma.userNotification.findMany({
      where: {
        userId,
        ...(q.audience && { audience: q.audience }),
        ...(q.groupId && { groupId: q.groupId }),
        ...(q.unreadOnly && { readAt: null }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async unreadCount(
    userId: string,
    q: { audience?: NotificationAudience; groupId?: string } = {},
  ) {
    return this.prisma.userNotification.count({
      where: {
        userId,
        readAt: null,
        ...(q.audience && { audience: q.audience }),
        ...(q.groupId && { groupId: q.groupId }),
      },
    });
  }

  async markRead(userId: string, notificationId: string) {
    const row = await this.prisma.userNotification.findFirst({
      where: { id: notificationId, userId },
    });
    if (!row) {
      throw new NotFoundException('Notification not found.');
    }
    if (row.readAt) {
      return row;
    }
    return this.prisma.userNotification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(
    userId: string,
    q: { audience?: NotificationAudience; groupId?: string } = {},
  ) {
    return this.prisma.userNotification.updateMany({
      where: {
        userId,
        readAt: null,
        ...(q.audience && { audience: q.audience }),
        ...(q.groupId && { groupId: q.groupId }),
      },
      data: { readAt: new Date() },
    });
  }
}
