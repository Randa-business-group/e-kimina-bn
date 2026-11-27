import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { RoleName } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { appConfig } from '../../config/app.config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

type AppConfig = ReturnType<typeof appConfig>;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get('auth.jwtSecret', { infer: true }),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (payload.purpose) {
      throw new UnauthorizedException(
        'This token cannot be used as a session.',
      );
    }
    // Stateless JWTs are checked against the account so suspension and "reset access"
    // take effect immediately (msfts §6).
    const u = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { suspendedAt: true, sessionVersion: true, isActive: true },
    });
    if (!u || !u.isActive) {
      throw new UnauthorizedException('Your session is no longer valid.');
    }
    if (u.suspendedAt && !payload.imp) {
      throw new UnauthorizedException(
        'This account is suspended. Contact support.',
      );
    }
    if ((payload.sv ?? 0) !== u.sessionVersion) {
      throw new UnauthorizedException(
        'Your session has ended. Please sign in again.',
      );
    }
    if (payload.sid) {
      // Signing a device out (or reuse detection) ends its access token at once.
      const s = await this.prisma.refreshToken.findUnique({
        where: { id: payload.sid },
        select: { revokedAt: true, revokedReason: true },
      });
      if (!s || (s.revokedAt && s.revokedReason !== 'rotated')) {
        throw new UnauthorizedException('This device was signed out.');
      }
    }
    return {
      id: payload.sub,
      email: payload.email,
      platformRole: payload.platformRole ?? RoleName.USER,
      ...(payload.imp ? { impersonatorId: payload.imp } : {}),
      ...(payload.ro ? { readOnly: true } : {}),
      ...(payload.sid ? { sessionId: payload.sid } : {}),
    };
  }
}
