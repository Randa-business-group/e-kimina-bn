import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { HealthService } from './health.service';

type StatusRes = { status: (code: number) => unknown };

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary:
      'Full report: database, SMTP, Cloudinary, SMS, MoMo, job queue (503 when the database is down)',
  })
  async getHealth(@Res({ passthrough: true }) res: StatusRes) {
    const r = await this.healthService.check();
    if (r.status === 'down') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return r;
  }

  @Get('live')
  @Public()
  @ApiOperation({ summary: 'Liveness: the process answers' })
  live() {
    return this.healthService.live();
  }

  @Get('ready')
  @Public()
  @ApiOperation({ summary: 'Readiness: the database answers (503 otherwise)' })
  async ready(@Res({ passthrough: true }) res: StatusRes) {
    const r = await this.healthService.ready();
    if (r.status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return r;
  }
}
