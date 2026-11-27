import { RoleName } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  email: string;
  platformRole: RoleName;
  /** Super admin viewing the app as this user (read-only session). */
  impersonatorId?: string;
  /** Only GET/HEAD/OPTIONS are allowed with this session. */
  readOnly?: boolean;
  /** Device session id (refresh-token row). */
  sessionId?: string;
}
