import { Global, Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PaymentAccountsService } from './payment-accounts.service';
import { PlatformSettingsService } from './platform-settings.service';

/** Shared by every module: audit log writer, platform settings, group payment accounts. */
@Global()
@Module({
  providers: [AuditService, PlatformSettingsService, PaymentAccountsService],
  exports: [AuditService, PlatformSettingsService, PaymentAccountsService],
})
export class PlatformModule {}
