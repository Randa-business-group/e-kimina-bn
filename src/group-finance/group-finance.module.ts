import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { FinanceCoreModule } from '../finance-core/finance-core.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FinanceJobsService } from './finance-jobs.service';
import { FinesService } from './fines.service';
import { LoanExtrasService } from './loan-extras.service';
import { GroupFinanceController } from './group-finance.controller';
import { GroupFinanceService } from './group-finance.service';
import { GroupLoansService } from './group-loans.service';
import {
  AdminFinanceController,
  MomoCallbackController,
} from './payments-callback.controller';

@Module({
  imports: [
    PrismaModule,
    EmailModule,
    NotificationsModule,
    FinanceCoreModule,
    PaymentsModule,
  ],
  controllers: [
    GroupFinanceController,
    MomoCallbackController,
    AdminFinanceController,
  ],
  providers: [
    GroupFinanceService,
    GroupLoansService,
    FinesService,
    FinanceJobsService,
    LoanExtrasService,
  ],
  exports: [
    GroupFinanceService,
    GroupLoansService,
    FinesService,
    FinanceJobsService,
  ],
})
export class GroupFinanceModule {}
