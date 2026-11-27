import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GroupMembershipStatus, RoleName } from '@prisma/client';
import { GROUP_ROLES_KEY } from '../../decorators/group-role.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../../platform/platform-settings.service';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

@Injectable()
export class GroupRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<RoleName[]>(
      GROUP_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      params?: { groupId?: string };
      method?: string;
    }>();

    const user = request.user;

    if (!user) {
      return false;
    }

    const method = (request.method ?? 'GET').toUpperCase();
    const readOnlySuperAdmin =
      (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') &&
      user.platformRole === RoleName.SUPER_ADMIN;

    const groupId = request.params?.groupId;

    if (!groupId) {
      throw new ForbiddenException(
        'This route requires a :groupId route parameter.',
      );
    }

    const membership = await this.prisma.userGroup.findFirst({
      where: {
        userId: user.id,
        groupId,
        membershipStatus: GroupMembershipStatus.ACTIVE,
        // Soft-deleted groups are closed to members (super admins keep read access below).
        group: { deletedAt: null },
      },
      include: {
        role: true,
        user: { select: { twoFactorMethod: true } },
      },
    });

    if (!membership) {
      if (readOnlySuperAdmin) {
        return true;
      }
      return false;
    }

    if (!requiredRoles.includes(membership.role.name)) return false;

    // msfts §8: when the platform requires it, leaders need two-step verification to act.
    const leader =
      membership.role.name === RoleName.GROUP_ADMIN ||
      membership.role.name === RoleName.TREASURER;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (leader && mutating && !membership.user.twoFactorMethod) {
      const settings = await this.settings.get();
      if (settings.requireLeaderTwoFactor) {
        throw new ForbiddenException(
          'Group admins and treasurers must turn on two-step verification first (Settings → Security).',
        );
      }
    }
    return true;
  }
}
