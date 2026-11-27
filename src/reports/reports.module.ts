import { Module } from '@nestjs/common';
import { FinanceCoreModule } from '../finance-core/finance-core.module';
import { GroupAccountingModule } from '../group-accounting/group-accounting.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PlatformReportsService } from './platform-reports.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** msfts §5 — reports, statements, receipts, chart data, platform metrics. */
@Module({
  imports: [PrismaModule, FinanceCoreModule, GroupAccountingModule],
  controllers: [ReportsController],
  providers: [ReportsService, PlatformReportsService],
})
export class ReportsModule {}
