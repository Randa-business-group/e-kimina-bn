import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { FinanceCoreModule } from '../finance-core/finance-core.module';
import { GroupsModule } from '../groups/groups.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RolesModule } from '../roles/roles.module';
import { ConstitutionService } from './constitution.service';
import { ExitService } from './exit.service';
import { GovernanceAccessService } from './governance-access.service';
import { GovernanceJobsService } from './governance-jobs.service';
import { GroupGovernanceController } from './group-governance.controller';
import { MeetingsService } from './meetings.service';
import { MembershipService } from './membership.service';
import { PollsService } from './polls.service';

/** msfts §3 — members and governance. */
@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    EmailModule,
    RolesModule,
    GroupsModule,
    FinanceCoreModule,
  ],
  controllers: [GroupGovernanceController],
  providers: [
    GovernanceAccessService,
    MembershipService,
    ExitService,
    MeetingsService,
    ConstitutionService,
    PollsService,
    GovernanceJobsService,
  ],
  exports: [ConstitutionService, MembershipService],
})
export class GroupGovernanceModule {}
