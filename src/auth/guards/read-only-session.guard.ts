import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import type { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/** Impersonation sessions may look but not touch; attempts are audited. */
@Injectable()
export class ReadOnlySessionGuard implements CanActivate {
  constructor(private readonly audit: AuditService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<{
      method: string;
      originalUrl?: string;
      url: string;
      ip?: string;
      params?: Record<string, string>;
      user?: AuthenticatedUser;
    }>();
    if (!req.user?.readOnly) return true;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()))
      return true;
    void this.audit.record({
      action: 'auth.read_only_write_blocked',
      actorId: req.user.id,
      actorRole: req.user.platformRole,
      impersonatorId: req.user.impersonatorId ?? null,
      method: req.method,
      path: req.originalUrl ?? req.url,
      groupId: req.params?.groupId ?? null,
      ip: req.ip ?? null,
      statusCode: 403,
    });
    throw new ForbiddenException(
      'This is a read-only support session. Changes are not allowed.',
    );
  }
}
