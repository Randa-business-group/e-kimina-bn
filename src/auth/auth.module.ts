import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { appConfig } from '../config/app.config';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { PhoneOtpService } from './phone-otp.service';
import { TokensService } from './tokens.service';
import { TwoFactorService } from './two-factor.service';

type AppConfig = ReturnType<typeof appConfig>;

@Module({
  imports: [
    ConfigModule,
    UsersModule,
    NotificationsModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => ({
        secret: configService.get('auth.jwtSecret', { infer: true }),
        // Access tokens are short-lived (ACCESS_TOKEN_TTL, default 15m); refresh tokens renew them.
        signOptions: {
          expiresIn: (process.env.ACCESS_TOKEN_TTL?.trim() ||
            '15m') as unknown as number,
        },
      }),
    }),
  ],
  controllers: [AuthController, AccountController],
  providers: [
    AuthService,
    JwtStrategy,
    TokensService,
    PhoneOtpService,
    TwoFactorService,
    AccountService,
  ],
  exports: [AuthService, AccountService, TokensService],
})
export class AuthModule {}
