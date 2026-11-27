import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GroupMembershipStatus, RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AccessContext {
  group: { id: string; name: string; isVerified: boolean };
  role: RoleName | null;
  isLeader: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

/** Shared access checks for accounting routes (live, verified group + role). */
@Injectable()
export class AccountingAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async context(
    userId: string,
    groupId: string,
    opts: { allowSuperAdminRead?: boolean } = {},
  ) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true, name: true, isVerified: true, deletedAt: true },
    });
    if (!group || group.deletedAt)
      throw new NotFoundException(`Group ${groupId} was not found.`);
    if (!group.isVerified) {
      throw new ForbiddenException(
        'Accounting is only available for verified groups.',
      );
    }
    const m = await this.prisma.userGroup.findFirst({
      where: {
        userId,
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
      },
      include: { role: true },
    });
    let isSuperAdmin = false;
    if (!m) {
      if (opts.allowSuperAdminRead) {
        const pr = await this.prisma.userPlatformRole.findFirst({
          where: { userId },
          include: { role: true },
        });
        isSuperAdmin = pr?.role.name === RoleName.SUPER_ADMIN;
      }
      if (!isSuperAdmin)
        throw new ForbiddenException(
          'You are not an active member of this group.',
        );
    }
    const role = m?.role.name ?? null;
    const ctx: AccessContext = {
      group,
      role,
      isLeader: role === RoleName.GROUP_ADMIN || role === RoleName.TREASURER,
      isAdmin: role === RoleName.GROUP_ADMIN,
      isSuperAdmin,
    };
    return ctx;
  }

  async member(userId: string, groupId: string) {
    return this.context(userId, groupId, { allowSuperAdminRead: true });
  }

  async leader(userId: string, groupId: string, what = 'do this') {
    const ctx = await this.context(userId, groupId);
    if (!ctx.isLeader) {
      throw new ForbiddenException(
        `Only a group admin or the treasurer can ${what}.`,
      );
    }
    return ctx;
  }

  async admin(userId: string, groupId: string, what = 'do this') {
    const ctx = await this.context(userId, groupId);
    if (!ctx.isAdmin)
      throw new ForbiddenException(`Only the group admin can ${what}.`);
    return ctx;
  }

  /** Leaders + super admins (read-only reports). */
  async reader(userId: string, groupId: string) {
    const ctx = await this.context(userId, groupId, {
      allowSuperAdminRead: true,
    });
    if (!ctx.isLeader && !ctx.isSuperAdmin) {
      throw new ForbiddenException(
        'Only group leaders can view the full ledger.',
      );
    }
    return ctx;
  }
}
