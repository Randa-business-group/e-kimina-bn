import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ContributionScheduleService } from './contribution-schedule.service';
import { GroupCashService } from './group-cash.service';
import { LoanPenaltyService } from './loan-penalty.service';
import { PaymentAllocationService } from './payment-allocation.service';

/** Money rules shared by deposits, loans, configs and the scheduler. */
@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [
    ContributionScheduleService,
    PaymentAllocationService,
    GroupCashService,
    LoanPenaltyService,
  ],
  exports: [
    ContributionScheduleService,
    PaymentAllocationService,
    GroupCashService,
    LoanPenaltyService,
  ],
})
export class FinanceCoreModule {}
