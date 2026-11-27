import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [PrismaModule, PaymentsModule, NotificationsModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
