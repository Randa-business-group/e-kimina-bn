import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { MembershipService } from './membership.service';
import { PollsService } from './polls.service';

/** Closes expired votes (every 10 min) and removes long-expired invitations (daily). */
@Injectable()
export class GovernanceJobsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(GovernanceJobsService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly polls: PollsService,
    private readonly membership: MembershipService,
  ) {}

  onApplicationBootstrap() {
    if (
      process.env.FINANCE_JOBS_ENABLED === 'false' ||
      process.env.NODE_ENV === 'test'
    )
      return;
    const closePolls = () =>
      void this.polls
        .closeExpired()
        .then((n) => n && this.logger.log(`Closed ${n} expired vote(s)`))
        .catch((e) => this.logger.error(e));
    const cleanup = () =>
      void this.membership
        .cleanupExpiredInvitations()
        .then((n) => n && this.logger.log(`Removed ${n} expired invitation(s)`))
        .catch((e) => this.logger.error(e));
    this.timers.push(
      setTimeout(closePolls, 30_000),
      setInterval(closePolls, 10 * 60_000),
    );
    this.timers.push(
      setTimeout(cleanup, 60_000),
      setInterval(cleanup, 24 * 3_600_000),
    );
  }

  onModuleDestroy() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
