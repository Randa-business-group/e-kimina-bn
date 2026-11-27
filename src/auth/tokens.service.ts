import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { ClientCtx } from '../common/http-ctx';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './interfaces/jwt-payload.interface';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Benign race: two tabs refreshing with the same token within this window. */
const ROTATION_GRACE_MS = 20_000;

export type IssuedSession = {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
};

/**
 * Short-lived access JWTs + rotating refresh tokens (msfts §8). Refresh tokens are random,
 * stored hashed, bound to the account's session version, and rotated on every use.
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  get accessTtl(): string {
    return process.env.ACCESS_TOKEN_TTL?.trim() || '15m';
  }

  get refreshDays(): number {
    const n = Number(process.env.REFRESH_TOKEN_DAYS);
    return Number.isFinite(n) && n > 0 ? n : 30;
  }

  async accessToken(
    user: { id: string; email: string; platformRole: RoleName },
    extra: Pick<JwtPayload, 'imp' | 'ro' | 'sid'> = {},
    expiresIn?: number | string,
  ): Promise<string> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { sessionVersion: true },
    });
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      platformRole: user.platformRole,
      sv: row?.sessionVersion ?? 0,
      ...extra,
    };
    return this.jwt.signAsync(payload, {
      expiresIn: (expiresIn ?? this.accessTtl) as unknown as number,
    });
  }

  private async newRefresh(
    userId: string,
    familyId: string,
    sessionVersion: number,
    ctx: ClientCtx,
  ) {
    const token = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshDays * 86400_000);
    const row = await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: sha256(token),
        sessionVersion,
        expiresAt,
        userAgent: ctx.userAgent,
        ip: ctx.ip,
      },
    });
    return { token, row };
  }

  /** New device session (login, verified email, invitation completed, password changed). */
  async issue(
    user: { id: string; email: string; platformRole: RoleName },
    ctx: ClientCtx,
  ): Promise<IssuedSession> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { sessionVersion: true },
    });
    const { token, row } = await this.newRefresh(
      user.id,
      randomUUID(),
      u.sessionVersion,
      ctx,
    );
    return {
      accessToken: await this.accessToken(user, { sid: row.id }),
      refreshToken: token,
      refreshExpiresAt: row.expiresAt,
      sessionId: row.id,
    };
  }

  /** Rotate a refresh token. Reuse of an already-rotated token revokes the whole family. */
  async rotate(
    raw: string,
    ctx: ClientCtx,
    platformRoleOf: (userId: string) => Promise<RoleName>,
  ) {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(raw) },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            sessionVersion: true,
            suspendedAt: true,
            isActive: true,
          },
        },
      },
    });
    if (!row) throw new UnauthorizedException('Please sign in again.');
    if (row.revokedAt) {
      const benign =
        row.revokedReason === 'rotated' &&
        Date.now() - row.revokedAt.getTime() < ROTATION_GRACE_MS;
      if (!benign) {
        await this.revokeFamily(row.familyId, 'reuse-detected');
        void this.audit.record({
          action: 'auth.refresh_reuse_detected',
          actorId: row.userId,
          entityType: 'RefreshToken',
          entityId: row.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          statusCode: 401,
        });
      }
      throw new UnauthorizedException('Please sign in again.');
    }
    const u = row.user;
    if (
      row.expiresAt < new Date() ||
      !u.isActive ||
      u.suspendedAt ||
      row.sessionVersion !== u.sessionVersion
    ) {
      await this.prisma.refreshToken.update({
        where: { id: row.id },
        data: { revokedAt: new Date(), revokedReason: 'expired' },
      });
      throw new UnauthorizedException('Please sign in again.');
    }
    const { token, row: next } = await this.newRefresh(
      u.id,
      row.familyId,
      u.sessionVersion,
      ctx,
    );
    // Only one rotation wins if two requests race.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: 'rotated',
        replacedById: next.id,
      },
    });
    if (claimed.count === 0) {
      await this.prisma.refreshToken.delete({ where: { id: next.id } });
      throw new UnauthorizedException('Please sign in again.');
    }
    const platformRole = await platformRoleOf(u.id);
    return {
      userId: u.id,
      accessToken: await this.accessToken(
        { id: u.id, email: u.email, platformRole },
        { sid: next.id },
      ),
      refreshToken: token,
      refreshExpiresAt: next.expiresAt,
    };
  }

  async revokeRaw(raw: string | null, reason = 'logout') {
    if (!raw) return;
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(raw), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  revokeFamily(familyId: string, reason: string) {
    return this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Every device out, including access tokens (session version bump). */
  async revokeAll(userId: string, reason: string) {
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { sessionVersion: { increment: 1 } },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      }),
    ]);
  }

  /** Active devices: the latest token of each live family. */
  async sessions(userId: string, currentSessionId?: string) {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const families = await this.prisma.refreshToken.groupBy({
      by: ['familyId'],
      where: { familyId: { in: [...new Set(rows.map((r) => r.familyId))] } },
      _min: { createdAt: true },
    });
    const since = new Map(families.map((f) => [f.familyId, f._min.createdAt]));
    return rows.map((r) => ({
      id: r.id,
      userAgent: r.userAgent,
      ip: r.ip,
      signedInAt: since.get(r.familyId) ?? r.createdAt,
      lastActiveAt: r.createdAt,
      expiresAt: r.expiresAt,
      current: r.id === currentSessionId,
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    const row = await this.prisma.refreshToken.findFirst({
      where: { id: sessionId, userId },
    });
    if (!row) return { revoked: 0 };
    const r = await this.revokeFamily(row.familyId, 'revoked-by-user');
    return { revoked: r.count };
  }
}
