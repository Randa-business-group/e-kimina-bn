import { Body, Controller, HttpCode, Post, Put } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Public } from '../decorators/public.decorator';
import { Roles } from '../decorators/roles.decorator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FinanceJobsService } from './finance-jobs.service';
import { GroupFinanceService } from './group-finance.service';
import { GroupLoansService } from './group-loans.service';

type MomoCallbackBody = {
  externalId?: string;
  referenceId?: string;
  status?: string;
};

/**
 * MTN MoMo callbacks (X-Callback-Url). The body is only used to find our record; the status is
 * always re-read from MTN with our credentials, so a forged callback cannot confirm a payment.
 */
@ApiExcludeController()
@Controller('payments/momo/callback')
export class MomoCallbackController {
  constructor(
    private readonly groupFinance: GroupFinanceService,
    private readonly groupLoans: GroupLoansService,
  ) {}

  @Public()
  @Put('collection')
  @HttpCode(200)
  collectionPut(@Body() body: MomoCallbackBody) {
    return this.groupFinance.handleMomoCollectionCallback(body ?? {});
  }

  @Public()
  @Post('collection')
  @HttpCode(200)
  collectionPost(@Body() body: MomoCallbackBody) {
    return this.groupFinance.handleMomoCollectionCallback(body ?? {});
  }

  @Public()
  @Put('disbursement')
  @HttpCode(200)
  disbursementPut(@Body() body: MomoCallbackBody) {
    return this.groupLoans.handleMomoDisbursementCallback(body ?? {});
  }

  @Public()
  @Post('disbursement')
  @HttpCode(200)
  disbursementPost(@Body() body: MomoCallbackBody) {
    return this.groupLoans.handleMomoDisbursementCallback(body ?? {});
  }
}

@ApiTags('admin-finance')
@ApiBearerAuth('JWT-auth')
@Controller('admin/finance')
export class AdminFinanceController {
  constructor(private readonly jobs: FinanceJobsService) {}

  @Post('run-daily-jobs')
  @Roles(RoleName.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Super admin: run the daily money jobs for every group now',
  })
  runAll() {
    return this.jobs.runDaily();
  }
}
