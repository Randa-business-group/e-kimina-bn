import { Global, Module } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';

/** Background job queue shared by every module (msfts §10). */
@Global()
@Module({
  providers: [JobQueueService],
  exports: [JobQueueService],
})
export class JobsModule {}
