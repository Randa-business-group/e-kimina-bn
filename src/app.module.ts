import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { EmailModule } from './email/email.module';
import { GroupRoleGuard } from './auth/guards/group-role.guard';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { ReadOnlySessionGuard } from './auth/guards/read-only-session.guard';
import { AuditInterceptor } from './audit/audit.interceptor';
import { RateLimitInterceptor, RateLimitStore } from './common/rate-limit';
import { AdminModule } from './admin/admin.module';
import { PlatformModule } from './platform/platform.module';
import { JobsModule } from './jobs/jobs.module';
import { appConfig } from './config/app.config';
import { validateEnv } from './config/env.validation';
import { ContributionConfigModule } from './contribution-config/contribution-config.module';
import { ContributionsModule } from './contributions/contributions.module';
import { GroupsModule } from './groups/groups.module';
import { GroupFinanceModule } from './group-finance/group-finance.module';
import { GroupAccountingModule } from './group-accounting/group-accounting.module';
import { GroupGovernanceModule } from './group-governance/group-governance.module';
import { ReportsModule } from './reports/reports.module';
import { HealthModule } from './health/health.module';
import { LoanConfigModule } from './loan-config/loan-config.module';
import { PrismaModule } from './prisma/prisma.module';
import { RolesModule } from './roles/roles.module';
import { UploadModule } from './upload/upload.module';
import { UserFinanceModule } from './user-finance/user-finance.module';
import { UsersModule } from './users/users.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig],
      validate: validateEnv,
    }),
    PrismaModule,
    PlatformModule,
    JobsModule,
    EmailModule,
    HealthModule,
    AuthModule,
    UsersModule,
    RolesModule,
    GroupsModule,
    LoanConfigModule,
    ContributionConfigModule,
    ContributionsModule,
    GroupFinanceModule,
    GroupAccountingModule,
    GroupGovernanceModule,
    ReportsModule,
    AdminModule,
    UserFinanceModule,
    UploadModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    RateLimitStore,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ReadOnlySessionGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: GroupRoleGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RateLimitInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
})
export class AppModule {}
