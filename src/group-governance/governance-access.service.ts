import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GroupMembershipStatus, RoleName } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface GovContext {
  group: {
    id: string;
    name: string;
    isVerified: boolean;
    maxMembers: number;
    minMembers: number;
    createdById: string;
  };
  role: RoleName | null;
  isLeader: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

/** Access checks for governance routes (live group; verification not required). */
@Injectable()
export class GovernanceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async context(
    userId: string,
    groupId: string,
    opts: { allowSuperAdmin?: boolean } = {},
  ): Promise<GovContext> {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true,
        isVerified: true,
        maxMembers: true,
        minMembers: true,
        createdById: true,
        deletedAt: true,
      },
    });
    if (!group || group.deletedAt) {
      throw new NotFoundException(`Group ${groupId} was not found.`);
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
      if (opts.allowSuperAdmin) {
        const pr = await this.prisma.userPlatformRole.findFirst({
          where: { userId },
          include: { role: true },
        });
        isSuperAdmin = pr?.role.name === RoleName.SUPER_ADMIN;
      }
      if (!isSuperAdmin) {
        throw new ForbiddenException(
          'You are not an active member of this group.',
        );
      }
    }
    const role = m?.role.name ?? null;
    return {
      group,
      role,
      isLeader: role === RoleName.GROUP_ADMIN || role === RoleName.TREASURER,
      isAdmin: role === RoleName.GROUP_ADMIN,
      isSuperAdmin,
    };
  }

  member(userId: string, groupId: string) {
    return this.context(userId, groupId, { allowSuperAdmin: true });
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

  /** Group admin, or a platform super admin acting on behalf of the group. */
  async admin(
    userId: string,
    groupId: string,
    what = 'do this',
    allowSuperAdmin = false,
  ) {
    const ctx = await this.context(userId, groupId, { allowSuperAdmin });
    if (!ctx.isAdmin && !(allowSuperAdmin && ctx.isSuperAdmin)) {
      throw new ForbiddenException(`Only the group admin can ${what}.`);
    }
    return ctx;
  }
}
