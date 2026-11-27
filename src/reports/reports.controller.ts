import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { FundType, RoleName } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import { PlatformReportsService } from './platform-reports.service';
import {
  type FileOut,
  arrearsFile,
  cashBookFile,
  contributionMatrixFile,
  loanPortfolioFile,
  memberStatementFile,
  platformFile,
  receiptFile,
  shareOutFile,
} from './reports.render';
import { ReportsService } from './reports.service';

type U = AuthenticatedUser;
type Format = 'json' | 'csv' | 'pdf';

function format(
  f?: string,
  allowed: Format[] = ['json', 'csv', 'pdf'],
): Format {
  const v = (f ?? 'json').toLowerCase() as Format;
  if (!allowed.includes(v))
    throw new BadRequestException(
      `format must be one of: ${allowed.join(', ')}`,
    );
  return v;
}

function file(out: FileOut) {
  return new StreamableFile(out.buffer, {
    type: out.contentType,
    disposition: `attachment; filename="${out.filename}"`,
    length: out.buffer.length,
  });
}

function fund(f?: string): FundType {
  if (!f) return FundType.SAVINGS;
  if (f !== FundType.SAVINGS && f !== FundType.SOCIAL)
    throw new BadRequestException('fund must be SAVINGS or SOCIAL');
  return f;
}

/**
 * Reports, statements and analytics (msfts §5). Every report returns JSON, or a file with
 * `?format=csv|pdf`. Dates: `from` / `to` (ISO); default = open cycle, else last 12 months.
 */
@ApiTags('reports')
@ApiBearerAuth('JWT-auth')
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly platform: PlatformReportsService,
  ) {}

  @Get('groups/:groupId/reports/members/:userId/statement')
  @ApiOperation({
    summary:
      'Member statement (own, or any member for leaders) — JSON / CSV / PDF',
  })
  @ApiParam({ name: 'groupId' })
  @ApiParam({ name: 'userId', description: '"me" for yourself' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv', 'pdf'] })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  async memberStatement(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('userId') userId: string,
    @Query('format') f?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fmt = format(f);
    const d = await this.reports.memberStatement(
      u.id,
      g,
      userId === 'me' ? u.id : userId,
      await this.reports.range(g, from, to),
    );
    return fmt === 'json' ? d : file(memberStatementFile(d, fmt));
  }

  @Get('groups/:groupId/reports/contribution-matrix')
  @ApiOperation({
    summary:
      'Leaders: members × periods (paid / late / pending) — JSON / CSV / PDF',
  })
  @ApiParam({ name: 'groupId' })
  @ApiQuery({ name: 'fund', required: false, enum: ['SAVINGS', 'SOCIAL'] })
  async contributionMatrix(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Query('format') f?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fund') fd?: string,
  ) {
    const fmt = format(f);
    const d = await this.reports.contributionMatrix(
      u.id,
      g,
      await this.reports.range(g, from, to),
      fund(fd),
    );
    return fmt === 'json' ? d : file(contributionMatrixFile(d, fmt));
  }

  @Get('groups/:groupId/reports/arrears')
  @ApiOperation({ summary: 'Leaders: arrears & defaulters — JSON / CSV / PDF' })
  @ApiParam({ name: 'groupId' })
  async arrears(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Query('format') f?: string,
  ) {
    const fmt = format(f);
    const d = await this.reports.arrears(u.id, g);
    return fmt === 'json' ? d : file(arrearsFile(d, fmt));
  }

  @Get('groups/:groupId/reports/loan-portfolio')
  @ApiOperation({
    summary:
      'Leaders: loan portfolio, ageing, PAR 30/60/90, interest earned — JSON / CSV / PDF',
  })
  @ApiParam({ name: 'groupId' })
  async loanPortfolio(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Query('format') f?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fmt = format(f);
    const d = await this.reports.loanPortfolio(
      u.id,
      g,
      await this.reports.range(g, from, to),
    );
    return fmt === 'json' ? d : file(loanPortfolioFile(d, fmt));
  }

  @Get('groups/:groupId/reports/cash-book')
  @ApiOperation({
    summary: 'Leaders: cash book with running balance — JSON / CSV / PDF',
  })
  @ApiParam({ name: 'groupId' })
  @ApiQuery({
    name: 'fund',
    required: false,
    enum: ['SAVINGS', 'SOCIAL', 'ALL'],
  })
  async cashBook(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Query('format') f?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fund') fd?: string,
  ) {
    const fmt = format(f);
    const d = await this.reports.cashBook(
      u.id,
      g,
      await this.reports.range(g, from, to),
      fd === 'ALL' ? 'ALL' : fund(fd),
    );
    return fmt === 'json' ? d : file(cashBookFile(d, fmt));
  }

  @Get('groups/:groupId/reports/cycles/:cycleId/share-out')
  @ApiOperation({
    summary: 'Share-out report (all members see every line) — JSON / CSV / PDF',
  })
  @ApiParam({ name: 'groupId' })
  @ApiParam({ name: 'cycleId' })
  async shareOut(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('cycleId') c: string,
    @Query('format') f?: string,
  ) {
    const fmt = format(f);
    const d = await this.reports.shareOut(u.id, g, c);
    return fmt === 'json' ? d : file(shareOutFile(d, fmt));
  }

  @Get('groups/:groupId/reports/receipts/:depositId')
  @ApiOperation({
    summary:
      'Payment receipt for a confirmed deposit (own, or leaders) — JSON / PDF',
  })
  @ApiParam({ name: 'groupId' })
  @ApiParam({ name: 'depositId' })
  async receipt(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('depositId') id: string,
    @Query('format') f?: string,
  ) {
    const fmt = format(f, ['json', 'pdf']);
    const d = await this.reports.receipt(u.id, g, id);
    return fmt === 'json' ? d : file(receiptFile(d));
  }

  @Get('groups/:groupId/reports/dashboard')
  @ApiOperation({
    summary: 'Chart data: monthly savings, loans vs cash, income (any member)',
  })
  @ApiParam({ name: 'groupId' })
  async dashboard(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Query('months') months?: string,
  ) {
    return this.reports.groupDashboard(u.id, g, months ? Number(months) : 12);
  }

  @Get('admin/reports/platform')
  @Roles(RoleName.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Super admin: platform metrics (groups, users, volume) — JSON / CSV',
  })
  async platformMetrics(
    @Query('months') months?: string,
    @Query('format') f?: string,
  ) {
    const fmt = format(f, ['json', 'csv']);
    const d = await this.platform.metrics(months ? Number(months) : 12);
    return fmt === 'json' ? d : file(platformFile(d));
  }
}
