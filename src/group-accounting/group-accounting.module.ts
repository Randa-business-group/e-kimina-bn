import { Module } from '@nestjs/common';
import { FinanceCoreModule } from '../finance-core/finance-core.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AccountingAccessService } from './accounting-access.service';
import { AccountingService } from './accounting.service';
import { CyclesService } from './cycles.service';
import { ExpensesService } from './expenses.service';
import { GroupAccountingController } from './group-accounting.controller';
import { RotationService } from './rotation.service';
import { SocialFundService } from './social-fund.service';

/** msfts §2 — ledger, cycles & share-out, expenses, social fund, rotating payouts. */
@Module({
  imports: [PrismaModule, NotificationsModule, FinanceCoreModule],
  controllers: [GroupAccountingController],
  providers: [
    AccountingAccessService,
    AccountingService,
    CyclesService,
    ExpensesService,
    SocialFundService,
    RotationService,
  ],
  exports: [AccountingService, CyclesService, AccountingAccessService],
})
export class GroupAccountingModule {}
