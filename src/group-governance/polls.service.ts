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
  Poll,
  PollKind,
  PollStatus,
  Prisma,
} from '@prisma/client';
import { GroupsService } from '../groups/groups.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { GovernanceAccessService } from './governance-access.service';
import { GroupRoleName, MembershipService } from './membership.service';

export interface PollInput {
  title: string;
  description?: string;
  kind: PollKind;
  options?: string[];
  targetUserId?: string;
  role?: GroupRoleName;
  reason?: string;
  closesAt: string;
  anonymous?: boolean;
  quorumPercent?: number;
  passPercent?: number;
}

interface PollPayload {
  userId?: string;
  role?: GroupRoleName;
  reason?: string;
}

const YES_NO = ['Yes', 'No'];

/** Group votes; ROLE_CHANGE and REMOVE_MEMBER polls are executed automatically when passed. */
@Injectable()
export class PollsService {
  private readonly logger = new Logger(PollsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GovernanceAccessService,
    private readonly membership: MembershipService,
    private readonly groups: GroupsService,
    private readonly notifications: NotificationsService,
  ) {}

  private options(p: Poll): string[] {
    return Array.isArray(p.options) ? (p.options as string[]) : [];
  }

  private payload(p: Poll): PollPayload {
    return (p.payload ?? {}) as PollPayload;
  }

  private async eligibleVoters(p: Poll) {
    const members = await this.prisma.userGroup.findMany({
      where: {
        groupId: p.groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
      },
      select: { userId: true },
    });
    const target =
      p.kind === PollKind.REMOVE_MEMBER ? this.payload(p).userId : undefined;
    return members.map((m) => m.userId).filter((u) => u !== target);
  }

  private async view(p: Poll, actorId: string) {
    const votes = await this.prisma.pollVote.findMany({
      where: { pollId: p.id },
    });
    const opts = this.options(p);
    const counts = opts.map(
      (_, i) => votes.filter((v) => v.optionIndex === i).length,
    );
    let voters:
      | { optionIndex: number; userId: string; fullName: string }[]
      | undefined;
    if (!p.anonymous) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: votes.map((v) => v.userId) } },
        select: { id: true, fullName: true },
      });
      const name = new Map(users.map((u) => [u.id, u.fullName]));
      voters = votes.map((v) => ({
        optionIndex: v.optionIndex,
        userId: v.userId,
        fullName: name.get(v.userId) ?? '',
      }));
    }
    const payload = this.payload(p);
    let targetName: string | null = null;
    if (payload.userId) {
      targetName =
        (
          await this.prisma.user.findUnique({
            where: { id: payload.userId },
            select: { fullName: true },
          })
        )?.fullName ?? null;
    }
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      kind: p.kind,
      target: payload.userId
        ? {
            userId: payload.userId,
            fullName: targetName,
            role: payload.role ?? null,
            reason: payload.reason ?? null,
          }
        : null,
      options: opts.map((label, i) => ({ index: i, label, votes: counts[i] })),
      status: p.status,
      anonymous: p.anonymous,
      quorumPercent: p.quorumPercent,
      passPercent: p.passPercent,
      closesAt: p.closesAt.toISOString(),
      totalVotes: votes.length,
      myVote: votes.find((v) => v.userId === actorId)?.optionIndex ?? null,
      result: p.result,
      executedAt: p.executedAt?.toISOString() ?? null,
      executionError: p.executionError,
      createdAt: p.createdAt.toISOString(),
      ...(voters ? { voters } : {}),
    };
  }

  async list(actorId: string, groupId: string, status?: PollStatus) {
    await this.access.member(actorId, groupId);
    await this.closeExpired(groupId);
    const rows = await this.prisma.poll.findMany({
      where: { groupId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map((p) => this.view(p, actorId)));
  }

  private async load(groupId: string, pollId: string) {
    const p = await this.prisma.poll.findFirst({
      where: { id: pollId, groupId },
    });
    if (!p) throw new NotFoundException('Poll not found.');
    return p;
  }

  async get(actorId: string, groupId: string, pollId: string) {
    await this.access.member(actorId, groupId);
    await this.closeExpired(groupId);
    return this.view(await this.load(groupId, pollId), actorId);
  }

  async create(actorId: string, groupId: string, dto: PollInput) {
    const ctx = await this.access.leader(actorId, groupId, 'open a vote');
    const closesAt = new Date(dto.closesAt);
    const now = Date.now();
    if (
      Number.isNaN(closesAt.getTime()) ||
      closesAt.getTime() < now + 10 * 60_000
    ) {
      throw new BadRequestException(
        'The vote must stay open for at least 10 minutes.',
      );
    }
    if (closesAt.getTime() > now + 60 * 86_400_000)
      throw new BadRequestException(
        'A vote can stay open for at most 60 days.',
      );
    let options = YES_NO;
    let payload: PollPayload | undefined;
    if (dto.kind === PollKind.GENERAL) {
      options = (dto.options ?? []).map((o) => o.trim()).filter(Boolean);
      if (options.length < 2 || options.length > 10)
        throw new BadRequestException('Give between 2 and 10 options.');
    } else if (
      dto.kind === PollKind.ROLE_CHANGE ||
      dto.kind === PollKind.REMOVE_MEMBER
    ) {
      if (!dto.targetUserId)
        throw new BadRequestException('targetUserId is required.');
      const target = await this.prisma.userGroup.findUnique({
        where: { userId_groupId: { userId: dto.targetUserId, groupId } },
        include: { role: true },
      });
      if (!target || target.membershipStatus !== GroupMembershipStatus.ACTIVE) {
        throw new BadRequestException('The target must be an active member.');
      }
      if (dto.kind === PollKind.ROLE_CHANGE) {
        if (!dto.role)
          throw new BadRequestException(
            'role is required for a role change vote.',
          );
        if (dto.role === target.role.name)
          throw new BadRequestException('The member already has this role.');
        payload = { userId: dto.targetUserId, role: dto.role };
      } else {
        if (!dto.reason || dto.reason.trim().length < 3)
          throw new BadRequestException('Give the reason for the removal.');
        payload = { userId: dto.targetUserId, reason: dto.reason.trim() };
      }
    }
    const p = await this.prisma.poll.create({
      data: {
        groupId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        kind: dto.kind,
        payload: payload as Prisma.InputJsonValue | undefined,
        options,
        anonymous: dto.anonymous ?? true,
        quorumPercent: dto.quorumPercent ?? 50,
        passPercent: dto.passPercent ?? 50,
        closesAt,
        createdById: actorId,
      },
    });
    void this.notifications
      .notifyAllMembers({
        groupId,
        type: NotificationType.POLL_OPENED,
        title: 'New vote',
        body: `“${p.title}” is open for voting in ${ctx.group.name} until ${closesAt.toISOString().slice(0, 10)}.`,
        metadata: { groupName: ctx.group.name, pollId: p.id },
      })
      .catch((e) => this.logger.error(e));
    return this.view(p, actorId);
  }

  async vote(
    actorId: string,
    groupId: string,
    pollId: string,
    optionIndex: number,
  ) {
    await this.access.context(actorId, groupId);
    const p = await this.load(groupId, pollId);
    if (p.status !== PollStatus.OPEN || p.closesAt <= new Date())
      throw new BadRequestException('This vote is closed.');
    if (optionIndex < 0 || optionIndex >= this.options(p).length)
      throw new BadRequestException('Invalid option.');
    if (
      p.kind === PollKind.REMOVE_MEMBER &&
      this.payload(p).userId === actorId
    ) {
      throw new ForbiddenException('You cannot vote on your own removal.');
    }
    await this.prisma.pollVote.upsert({
      where: { pollId_userId: { pollId, userId: actorId } },
      create: { pollId, userId: actorId, optionIndex },
      update: { optionIndex },
    });
    return this.view(p, actorId);
  }

  async cancel(actorId: string, groupId: string, pollId: string) {
    const ctx = await this.access.leader(actorId, groupId, 'cancel votes');
    const p = await this.load(groupId, pollId);
    if (p.status !== PollStatus.OPEN)
      throw new BadRequestException('This vote is not open.');
    if (p.createdById !== actorId && !ctx.isAdmin)
      throw new ForbiddenException(
        'Only its creator or the group admin can cancel a vote.',
      );
    const u = await this.prisma.poll.update({
      where: { id: pollId },
      data: {
        status: PollStatus.CANCELLED,
        closedAt: new Date(),
        closedById: actorId,
      },
    });
    return this.view(u, actorId);
  }

  /** Close early (creator / admin). */
  async close(actorId: string, groupId: string, pollId: string) {
    const ctx = await this.access.leader(actorId, groupId, 'close votes');
    const p = await this.load(groupId, pollId);
    if (p.status !== PollStatus.OPEN)
      throw new BadRequestException('This vote is not open.');
    if (p.createdById !== actorId && !ctx.isAdmin)
      throw new ForbiddenException(
        'Only its creator or the group admin can close a vote.',
      );
    const closed = await this.finalize(p, actorId);
    return this.view(closed, actorId);
  }

  /** Tally, decide, execute the action when passed, notify. */
  private async finalize(p: Poll, closerId: string | null): Promise<Poll> {
    const claimed = await this.prisma.poll.updateMany({
      where: { id: p.id, status: PollStatus.OPEN },
      data: {
        status: PollStatus.CLOSED,
        closedAt: new Date(),
        closedById: closerId,
      },
    });
    if (claimed.count === 0)
      return this.prisma.poll.findUniqueOrThrow({ where: { id: p.id } });
    const votes = await this.prisma.pollVote.findMany({
      where: { pollId: p.id },
    });
    const eligible = (await this.eligibleVoters(p)).length;
    const opts = this.options(p);
    const counts = opts.map(
      (_, i) => votes.filter((v) => v.optionIndex === i).length,
    );
    const turnoutPercent = eligible
      ? Math.round((votes.length / eligible) * 10000) / 100
      : 0;
    const quorumMet = turnoutPercent >= p.quorumPercent;
    let passed: boolean | null = null;
    let winner: string | null = null;
    if (p.kind === PollKind.GENERAL) {
      const max = Math.max(0, ...counts);
      const top = counts
        .map((c, i) => (c === max && max > 0 ? i : -1))
        .filter((i) => i >= 0);
      winner = quorumMet && top.length === 1 ? opts[top[0]] : null;
    } else {
      const yesPercent = votes.length ? (counts[0] / votes.length) * 100 : 0;
      passed = quorumMet && yesPercent > p.passPercent;
    }
    const result = {
      eligible,
      totalVotes: votes.length,
      turnoutPercent,
      quorumMet,
      counts,
      passed,
      winner,
    };

    let executedAt: Date | null = null;
    let executionError: string | null = null;
    if (
      passed &&
      (p.kind === PollKind.ROLE_CHANGE || p.kind === PollKind.REMOVE_MEMBER)
    ) {
      const payload = this.payload(p);
      const actor = closerId ?? p.createdById;
      try {
        if (p.kind === PollKind.ROLE_CHANGE) {
          await this.membership.changeRoleInternal(
            p.groupId,
            payload.userId!,
            payload.role!,
            actor,
            'vote',
          );
        } else {
          await this.groups.removeMemberInternal(
            p.groupId,
            payload.userId!,
            `Removed by group vote: ${payload.reason}`,
            actor,
          );
        }
        executedAt = new Date();
      } catch (e) {
        executionError = e instanceof Error ? e.message : String(e);
        this.logger.warn(
          `Poll ${p.id} passed but could not be executed: ${executionError}`,
        );
      }
    }
    const updated = await this.prisma.poll.update({
      where: { id: p.id },
      data: {
        result: result as Prisma.InputJsonValue,
        executedAt,
        executionError,
      },
    });
    const group = await this.prisma.group.findUnique({
      where: { id: p.groupId },
      select: { name: true },
    });
    const outcome =
      p.kind === PollKind.GENERAL
        ? winner
          ? `Result: “${winner}”.`
          : quorumMet
            ? 'No single winner (tie).'
            : 'Quorum not reached.'
        : passed
          ? `Passed${executedAt ? ' and applied' : ''}.`
          : quorumMet
            ? 'Not passed.'
            : 'Quorum not reached.';
    void this.notifications
      .notifyAllMembers({
        groupId: p.groupId,
        type: NotificationType.POLL_CLOSED,
        title: 'Vote closed',
        body: `“${p.title}” in ${group?.name ?? 'your group'}: ${outcome} (${votes.length}/${eligible} voted)`,
        metadata: { groupName: group?.name, pollId: p.id },
      })
      .catch((e) => this.logger.error(e));
    return updated;
  }

  /** Close every expired open poll (one group, or all). */
  async closeExpired(groupId?: string) {
    const due = await this.prisma.poll.findMany({
      where: {
        status: PollStatus.OPEN,
        closesAt: { lte: new Date() },
        ...(groupId ? { groupId } : {}),
      },
    });
    for (const p of due)
      await this.finalize(p, null).catch((e) => this.logger.error(e));
    return due.length;
  }
}
