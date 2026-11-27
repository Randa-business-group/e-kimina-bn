import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  GroupMembershipStatus,
  NotificationType,
  Prisma,
  RoleName,
} from '@prisma/client';
import { EmailService } from '../email/email.service.js';
import { dec, decN } from '../finance-core/money.util';
import { GroupsService } from '../groups/groups.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RolesService } from '../roles/roles.service';
import { GovernanceAccessService } from './governance-access.service';

const GROUP_ROLES = [
  RoleName.GROUP_ADMIN,
  RoleName.TREASURER,
  RoleName.MEMBER,
] as const;
export type GroupRoleName = (typeof GROUP_ROLES)[number];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ROLE_LABEL: Record<GroupRoleName, string> = {
  GROUP_ADMIN: 'group admin',
  TREASURER: 'treasurer',
  MEMBER: 'member',
};

export interface GovernanceSettingsInput {
  maxMembers?: number;
  minMembers?: number;
  joinRequiresApproval?: boolean;
  loanApprovalsRequired?: number;
  loanRequireAdminAndTreasurer?: boolean;
  expenseApprovalsRequired?: number;
  constitutionRequired?: boolean;
  defaultAbsenceFine?: number | null;
  defaultLateArrivalFine?: number | null;
}

export interface MemberProfileInput {
  nationalId?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  address?: string | null;
  occupation?: string | null;
  nextOfKinName?: string | null;
  nextOfKinPhone?: string | null;
  nextOfKinRelationship?: string | null;
  beneficiaryName?: string | null;
  beneficiaryPhone?: string | null;
  beneficiaryRelationship?: string | null;
}

/** Roles, join requests, governance settings, member profiles and invitations (msfts §3). */
@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GovernanceAccessService,
    private readonly roles: RolesService,
    private readonly groups: GroupsService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  // ── roles ───────────────────────────────────────────────────────────────

  private async activeAdmins(
    groupId: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    return db.userGroup.count({
      where: {
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
        role: { name: RoleName.GROUP_ADMIN },
      },
    });
  }

  /**
   * Change one member's role. Used by the admin endpoint and by passed ROLE_CHANGE votes.
   * The group always keeps at least one active group admin.
   */
  async changeRoleInternal(
    groupId: string,
    targetUserId: string,
    newRole: GroupRoleName,
    actorId: string | null,
    via: 'admin' | 'vote' = 'admin',
  ) {
    if (!GROUP_ROLES.includes(newRole))
      throw new BadRequestException('Invalid group role.');
    const ug = await this.prisma.userGroup.findUnique({
      where: { userId_groupId: { userId: targetUserId, groupId } },
      include: {
        role: true,
        user: { select: { fullName: true } },
        group: { select: { name: true } },
      },
    });
    if (!ug || ug.membershipStatus !== GroupMembershipStatus.ACTIVE) {
      throw new NotFoundException(
        'This user is not an active member of the group.',
      );
    }
    const oldRole = ug.role.name as GroupRoleName;
    if (oldRole === newRole)
      return { userId: targetUserId, role: newRole, changed: false };
    if (
      oldRole === RoleName.GROUP_ADMIN &&
      (await this.activeAdmins(groupId)) <= 1
    ) {
      throw new BadRequestException(
        'The group must keep at least one group admin. Appoint another admin first.',
      );
    }
    await this.prisma.userGroup.update({
      where: { id: ug.id },
      data: { roleId: await this.roles.getRoleId(newRole) },
    });
    const how = via === 'vote' ? 'after a group vote' : 'by the group admin';
    void this.notifications
      .notifyMember({
        userId: targetUserId,
        groupId,
        type: NotificationType.ROLE_CHANGED,
        title: 'Your role changed',
        body: `You are now ${ROLE_LABEL[newRole]} of ${ug.group.name} (changed ${how}).`,
        metadata: { groupName: ug.group.name, oldRole, newRole },
      })
      .catch((e) => this.logger.error(e));
    void this.notifications
      .notifyFinanceLeaders({
        groupId,
        type: NotificationType.ROLE_CHANGED,
        title: 'Role change',
        body: `${ug.user.fullName} is now ${ROLE_LABEL[newRole]} (was ${ROLE_LABEL[oldRole]}) in ${ug.group.name}.`,
        metadata: {
          groupName: ug.group.name,
          userId: targetUserId,
          oldRole,
          newRole,
        },
        excludeUserId: targetUserId,
      })
      .catch((e) => this.logger.error(e));
    this.logger.log(
      `Role of ${targetUserId} in ${groupId}: ${oldRole} → ${newRole} (${via}, actor ${actorId ?? 'system'})`,
    );
    return {
      userId: targetUserId,
      role: newRole,
      previousRole: oldRole,
      changed: true,
    };
  }

  async changeRole(
    actorId: string,
    groupId: string,
    targetUserId: string,
    role: GroupRoleName,
  ) {
    await this.access.admin(actorId, groupId, 'change member roles', true);
    return this.changeRoleInternal(groupId, targetUserId, role, actorId);
  }

  /** Make someone the treasurer; current treasurer(s) become `previousTreasurerRole`. */
  async replaceTreasurer(
    actorId: string,
    groupId: string,
    newTreasurerId: string,
    previousTreasurerRole: GroupRoleName = RoleName.MEMBER,
  ) {
    await this.access.admin(actorId, groupId, 'replace the treasurer', true);
    if (previousTreasurerRole === RoleName.TREASURER) {
      throw new BadRequestException(
        'The previous treasurer must get another role.',
      );
    }
    const current = await this.prisma.userGroup.findMany({
      where: {
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
        role: { name: RoleName.TREASURER },
        userId: { not: newTreasurerId },
      },
      select: { userId: true },
    });
    const result = await this.changeRoleInternal(
      groupId,
      newTreasurerId,
      RoleName.TREASURER,
      actorId,
    );
    for (const t of current) {
      await this.changeRoleInternal(
        groupId,
        t.userId,
        previousTreasurerRole,
        actorId,
      );
    }
    return { ...result, previousTreasurers: current.map((c) => c.userId) };
  }

  /** Hand the admin role to another member; the actor takes `myNewRole`. */
  async transferAdmin(
    actorId: string,
    groupId: string,
    targetUserId: string,
    myNewRole: GroupRoleName = RoleName.MEMBER,
  ) {
    await this.access.admin(actorId, groupId, 'transfer the admin role');
    if (targetUserId === actorId)
      throw new BadRequestException('Pick another member.');
    await this.changeRoleInternal(
      groupId,
      targetUserId,
      RoleName.GROUP_ADMIN,
      actorId,
    );
    if (myNewRole !== RoleName.GROUP_ADMIN) {
      await this.changeRoleInternal(groupId, actorId, myNewRole, actorId);
    }
    return { newAdminId: targetUserId, yourRole: myNewRole };
  }

  // ── join requests ───────────────────────────────────────────────────────

  async listJoinRequests(actorId: string, groupId: string) {
    await this.access.admin(actorId, groupId, 'review join requests', true);
    const rows = await this.prisma.userGroup.findMany({
      where: {
        groupId,
        membershipStatus: GroupMembershipStatus.PENDING_APPROVAL,
      },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, phoneNumber: true },
        },
      },
      orderBy: { joinRequestedAt: 'asc' },
    });
    return rows.map((r) => ({
      userId: r.userId,
      fullName: r.user.fullName,
      email: r.user.email,
      phoneNumber: r.user.phoneNumber,
      message: r.joinMessage,
      requestedAt: (r.joinRequestedAt ?? r.joinedAt).toISOString(),
      previouslyMember: r.exitedAt != null,
    }));
  }

  private async loadJoinRequest(groupId: string, userId: string) {
    const ug = await this.prisma.userGroup.findUnique({
      where: { userId_groupId: { userId, groupId } },
      include: { group: { select: { name: true, maxMembers: true } } },
    });
    if (!ug || ug.membershipStatus !== GroupMembershipStatus.PENDING_APPROVAL) {
      throw new NotFoundException('No pending join request for this user.');
    }
    return ug;
  }

  async approveJoin(actorId: string, groupId: string, userId: string) {
    await this.access.admin(actorId, groupId, 'approve join requests');
    const ug = await this.loadJoinRequest(groupId, userId);
    const active = await this.prisma.userGroup.count({
      where: { groupId, membershipStatus: GroupMembershipStatus.ACTIVE },
    });
    if (active >= ug.group.maxMembers) {
      throw new BadRequestException('The group has reached its member limit.');
    }
    await this.groups.activateMembership(groupId, userId);
    void this.notifications
      .notifyMember({
        userId,
        groupId,
        type: NotificationType.JOIN_APPROVED,
        title: 'Join request approved',
        body: `Welcome to ${ug.group.name}! Your request to join was approved.`,
        metadata: { groupName: ug.group.name },
      })
      .catch((e) => this.logger.error(e));
    return { userId, status: GroupMembershipStatus.ACTIVE };
  }

  async rejectJoin(
    actorId: string,
    groupId: string,
    userId: string,
    reason?: string,
  ) {
    await this.access.admin(actorId, groupId, 'reject join requests');
    const ug = await this.loadJoinRequest(groupId, userId);
    const hasHistory =
      ug.exitedAt != null ||
      (await this.prisma.contribution.count({ where: { groupId, userId } })) >
        0;
    if (hasHistory) {
      await this.prisma.userGroup.update({
        where: { id: ug.id },
        data: {
          membershipStatus: GroupMembershipStatus.EXITED,
          joinRequestedAt: null,
        },
      });
    } else {
      await this.prisma.userGroup.delete({ where: { id: ug.id } });
    }
    void this.notifications
      .notifyMember({
        userId,
        groupId: null,
        type: NotificationType.JOIN_REJECTED,
        title: 'Join request declined',
        body: `Your request to join ${ug.group.name} was declined.${reason?.trim() ? ` ${reason.trim()}` : ''}`,
        metadata: { groupName: ug.group.name, groupId },
      })
      .catch((e) => this.logger.error(e));
    return { userId, status: 'REJECTED' as const };
  }

  // ── governance settings ─────────────────────────────────────────────────

  private settingsDto(g: Prisma.GroupGetPayload<object>) {
    return {
      maxMembers: g.maxMembers,
      minMembers: g.minMembers,
      joinRequiresApproval: g.joinRequiresApproval,
      loanApprovalsRequired: g.loanApprovalsRequired,
      loanRequireAdminAndTreasurer: g.loanRequireAdminAndTreasurer,
      expenseApprovalsRequired: g.expenseApprovalsRequired,
      constitutionRequired: g.constitutionRequired,
      defaultAbsenceFine:
        g.defaultAbsenceFine != null ? decN(g.defaultAbsenceFine) : null,
      defaultLateArrivalFine:
        g.defaultLateArrivalFine != null
          ? decN(g.defaultLateArrivalFine)
          : null,
    };
  }

  async getSettings(actorId: string, groupId: string) {
    await this.access.member(actorId, groupId);
    const g = await this.prisma.group.findUniqueOrThrow({
      where: { id: groupId },
    });
    const leaders = await this.prisma.userGroup.groupBy({
      by: ['roleId'],
      where: { groupId, membershipStatus: GroupMembershipStatus.ACTIVE },
      _count: { _all: true },
    });
    const roleRows = await this.prisma.role.findMany({
      where: { id: { in: leaders.map((l) => l.roleId) } },
    });
    const countOf = (name: RoleName) =>
      leaders.find(
        (l) => roleRows.find((r) => r.id === l.roleId)?.name === name,
      )?._count._all ?? 0;
    return {
      ...this.settingsDto(g),
      activeMembers: leaders.reduce((a, l) => a + l._count._all, 0),
      admins: countOf(RoleName.GROUP_ADMIN),
      treasurers: countOf(RoleName.TREASURER),
    };
  }

  async updateSettings(
    actorId: string,
    groupId: string,
    dto: GovernanceSettingsInput,
  ) {
    await this.access.admin(actorId, groupId, 'change the group rules');
    const g = await this.prisma.group.findUniqueOrThrow({
      where: { id: groupId },
    });
    const max = dto.maxMembers ?? g.maxMembers;
    const min = dto.minMembers ?? g.minMembers;
    if (min > max)
      throw new BadRequestException(
        'Minimum members cannot exceed the maximum.',
      );
    if (dto.maxMembers != null) {
      const active = await this.prisma.userGroup.count({
        where: { groupId, membershipStatus: GroupMembershipStatus.ACTIVE },
      });
      if (dto.maxMembers < active) {
        throw new BadRequestException(
          `The group already has ${active} active members.`,
        );
      }
    }
    const updated = await this.prisma.group.update({
      where: { id: groupId },
      data: {
        ...(dto.maxMembers != null ? { maxMembers: dto.maxMembers } : {}),
        ...(dto.minMembers != null ? { minMembers: dto.minMembers } : {}),
        ...(dto.joinRequiresApproval != null
          ? { joinRequiresApproval: dto.joinRequiresApproval }
          : {}),
        ...(dto.loanApprovalsRequired != null
          ? { loanApprovalsRequired: dto.loanApprovalsRequired }
          : {}),
        ...(dto.loanRequireAdminAndTreasurer != null
          ? { loanRequireAdminAndTreasurer: dto.loanRequireAdminAndTreasurer }
          : {}),
        ...(dto.expenseApprovalsRequired != null
          ? { expenseApprovalsRequired: dto.expenseApprovalsRequired }
          : {}),
        ...(dto.constitutionRequired != null
          ? { constitutionRequired: dto.constitutionRequired }
          : {}),
        ...(dto.defaultAbsenceFine !== undefined
          ? {
              defaultAbsenceFine:
                dto.defaultAbsenceFine != null
                  ? dec(dto.defaultAbsenceFine)
                  : null,
            }
          : {}),
        ...(dto.defaultLateArrivalFine !== undefined
          ? {
              defaultLateArrivalFine:
                dto.defaultLateArrivalFine != null
                  ? dec(dto.defaultLateArrivalFine)
                  : null,
            }
          : {}),
      },
    });
    return this.settingsDto(updated);
  }

  // ── member profile ──────────────────────────────────────────────────────

  private profileDto(
    p: Prisma.GroupMemberProfileGetPayload<object> | null,
    userId: string,
    showSensitive: boolean,
  ) {
    return {
      userId,
      nationalId: showSensitive
        ? (p?.nationalId ?? null)
        : p?.nationalId
          ? '••••' + p.nationalId.slice(-4)
          : null,
      dateOfBirth: p?.dateOfBirth?.toISOString().slice(0, 10) ?? null,
      gender: p?.gender ?? null,
      address: p?.address ?? null,
      occupation: p?.occupation ?? null,
      nextOfKinName: p?.nextOfKinName ?? null,
      nextOfKinPhone: p?.nextOfKinPhone ?? null,
      nextOfKinRelationship: p?.nextOfKinRelationship ?? null,
      beneficiaryName: p?.beneficiaryName ?? null,
      beneficiaryPhone: p?.beneficiaryPhone ?? null,
      beneficiaryRelationship: p?.beneficiaryRelationship ?? null,
      complete: Boolean(
        p?.nationalId &&
        p?.nextOfKinName &&
        p?.nextOfKinPhone &&
        p?.beneficiaryName,
      ),
      updatedAt: p?.updatedAt.toISOString() ?? null,
    };
  }

  async getProfile(actorId: string, groupId: string, userId: string) {
    const ctx = await this.access.member(actorId, groupId);
    const self = userId === actorId;
    if (!self && !ctx.isLeader && !ctx.isSuperAdmin) {
      throw new ForbiddenException('You can only view your own profile.');
    }
    const member = await this.prisma.userGroup.findUnique({
      where: { userId_groupId: { userId, groupId } },
      include: {
        user: { select: { fullName: true, email: true, phoneNumber: true } },
      },
    });
    if (!member) throw new NotFoundException('This user is not in the group.');
    const p = await this.prisma.groupMemberProfile.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    return {
      fullName: member.user.fullName,
      email: member.user.email,
      phoneNumber: member.user.phoneNumber,
      ...this.profileDto(p, userId, self || ctx.isLeader),
    };
  }

  async listProfiles(actorId: string, groupId: string) {
    await this.access.leader(actorId, groupId, 'view member profiles');
    const members = await this.prisma.userGroup.findMany({
      where: { groupId, membershipStatus: GroupMembershipStatus.ACTIVE },
      include: { user: { select: { fullName: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    const profiles = await this.prisma.groupMemberProfile.findMany({
      where: { groupId },
    });
    return members.map((m) => ({
      fullName: m.user.fullName,
      ...this.profileDto(
        profiles.find((p) => p.userId === m.userId) ?? null,
        m.userId,
        true,
      ),
    }));
  }

  async upsertMyProfile(
    actorId: string,
    groupId: string,
    dto: MemberProfileInput,
  ) {
    await this.access.context(actorId, groupId);
    const dob = dto.dateOfBirth
      ? new Date(dto.dateOfBirth)
      : dto.dateOfBirth === null
        ? null
        : undefined;
    if (dob && Number.isNaN(dob.getTime()))
      throw new BadRequestException('Invalid dateOfBirth.');
    const clean = (v: string | null | undefined) =>
      v === undefined ? undefined : v?.trim() || null;
    const data = {
      nationalId: clean(dto.nationalId),
      dateOfBirth: dob,
      gender: clean(dto.gender),
      address: clean(dto.address),
      occupation: clean(dto.occupation),
      nextOfKinName: clean(dto.nextOfKinName),
      nextOfKinPhone: clean(dto.nextOfKinPhone),
      nextOfKinRelationship: clean(dto.nextOfKinRelationship),
      beneficiaryName: clean(dto.beneficiaryName),
      beneficiaryPhone: clean(dto.beneficiaryPhone),
      beneficiaryRelationship: clean(dto.beneficiaryRelationship),
    };
    const p = await this.prisma.groupMemberProfile.upsert({
      where: { groupId_userId: { groupId, userId: actorId } },
      create: { groupId, userId: actorId, ...data },
      update: data,
    });
    return this.profileDto(p, actorId, true);
  }

  // ── pending invitations ─────────────────────────────────────────────────

  async listInvitations(actorId: string, groupId: string) {
    await this.access.admin(actorId, groupId, 'manage invitations', true);
    const [members, treasurers] = await Promise.all([
      this.prisma.memberInvitation.findMany({
        where: { groupId },
        include: { user: { select: { email: true, isActive: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.treasurerInvitation.findMany({
        where: { groupId },
        include: { user: { select: { email: true, isActive: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const now = new Date();
    return [
      ...members.map((i) => ({ kind: 'MEMBER' as const, ...i })),
      ...treasurers.map((i) => ({ kind: 'TREASURER' as const, ...i })),
    ]
      .filter((i) => !i.user.isActive)
      .map((i) => ({
        id: i.id,
        kind: i.kind,
        email: i.user.email,
        createdAt: i.createdAt.toISOString(),
        expiresAt: i.expiresAt.toISOString(),
        expired: i.expiresAt < now,
      }));
  }

  private async findInvitation(groupId: string, invitationId: string) {
    const m = await this.prisma.memberInvitation.findFirst({
      where: { id: invitationId, groupId },
      include: { user: true, group: { select: { name: true } } },
    });
    if (m) return { kind: 'MEMBER' as const, inv: m };
    const t = await this.prisma.treasurerInvitation.findFirst({
      where: { id: invitationId, groupId },
      include: { user: true, group: { select: { name: true } } },
    });
    if (t) return { kind: 'TREASURER' as const, inv: t };
    throw new NotFoundException('Invitation not found.');
  }

  async resendInvitation(
    actorId: string,
    groupId: string,
    invitationId: string,
  ) {
    await this.access.admin(actorId, groupId, 'manage invitations');
    const { kind, inv } = await this.findInvitation(groupId, invitationId);
    if (inv.user.isActive)
      throw new BadRequestException(
        'This person already completed registration.',
      );
    if (!process.env.SMTP_HOST?.trim()) {
      throw new BadRequestException(
        'Configure SMTP in .env to send invitation emails.',
      );
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    if (kind === 'MEMBER') {
      await this.prisma.memberInvitation.update({
        where: { id: inv.id },
        data: { token, expiresAt },
      });
      await this.email.sendMemberInvitationEmail(
        inv.user.email,
        token,
        inv.group.name,
      );
    } else {
      await this.prisma.treasurerInvitation.update({
        where: { id: inv.id },
        data: { token, expiresAt },
      });
      await this.email.sendTreasurerInvitationEmail(
        inv.user.email,
        token,
        inv.group.name,
      );
    }
    return {
      id: inv.id,
      kind,
      expiresAt: expiresAt.toISOString(),
      message: 'Invitation email sent again.',
    };
  }

  /** Delete an invitation and the pending (never activated) account if it has nothing else. */
  private async deleteInvitation(
    kind: 'MEMBER' | 'TREASURER',
    inv: { id: string; userId: string; groupId: string },
  ) {
    await this.prisma.$transaction(async (tx) => {
      if (kind === 'MEMBER')
        await tx.memberInvitation.delete({ where: { id: inv.id } });
      else await tx.treasurerInvitation.delete({ where: { id: inv.id } });
      const user = await tx.user.findUnique({
        where: { id: inv.userId },
        select: { isActive: true },
      });
      if (!user || user.isActive) return;
      await tx.userGroup.deleteMany({
        where: { userId: inv.userId, groupId: inv.groupId },
      });
      const [groups, mInv, tInv] = await Promise.all([
        tx.userGroup.count({ where: { userId: inv.userId } }),
        tx.memberInvitation.count({ where: { userId: inv.userId } }),
        tx.treasurerInvitation.count({ where: { userId: inv.userId } }),
      ]);
      if (groups + mInv + tInv === 0)
        await tx.user.delete({ where: { id: inv.userId } });
    });
  }

  async revokeInvitation(
    actorId: string,
    groupId: string,
    invitationId: string,
  ) {
    await this.access.admin(actorId, groupId, 'manage invitations');
    const { kind, inv } = await this.findInvitation(groupId, invitationId);
    if (inv.user.isActive)
      throw new BadRequestException(
        'This person already completed registration.',
      );
    await this.deleteInvitation(kind, inv);
    return { id: invitationId, kind, revoked: true };
  }

  /** Daily: drop invitations that expired more than `graceDays` ago. */
  async cleanupExpiredInvitations(graceDays = 30) {
    const before = new Date(Date.now() - graceDays * 86_400_000);
    const [members, treasurers] = await Promise.all([
      this.prisma.memberInvitation.findMany({
        where: { expiresAt: { lt: before } },
      }),
      this.prisma.treasurerInvitation.findMany({
        where: { expiresAt: { lt: before } },
      }),
    ]);
    let removed = 0;
    for (const m of members) {
      await this.deleteInvitation('MEMBER', m)
        .then(() => removed++)
        .catch((e) => this.logger.error(e));
    }
    for (const t of treasurers) {
      await this.deleteInvitation('TREASURER', t)
        .then(() => removed++)
        .catch((e) => this.logger.error(e));
    }
    return removed;
  }
}
