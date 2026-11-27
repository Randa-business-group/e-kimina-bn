import { RoleName } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  email: string;
  /** Defaults to `USER` when omitted (legacy tokens). */
  platformRole?: RoleName;
  /**
   * Single-purpose tokens that are never sessions: the password-reset step or the
   * two-step sign-in challenge.
   */
  purpose?: 'password_reset' | '2fa';
  /** User.sessionVersion when issued; a bump revokes the token (missing = 0). */
  sv?: number;
  /** Impersonation: id of the super admin behind this session. */
  imp?: string;
  /** Read-only session (impersonation). */
  ro?: boolean;
  /** Refresh-token row of this device session (revoking it ends the access token too). */
  sid?: string;
}
