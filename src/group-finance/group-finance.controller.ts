import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseBoolPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { CurrentUser } from '../decorators/current-user.decorator';
import { GroupRole } from '../decorators/group-role.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { CreateLoanApplicationDto } from './dto/create-loan-application.dto';
import { DepositPreviewResponseDto } from './dto/deposit-preview-response.dto';
import { LoanRequestPreviewResponseDto } from './dto/loan-request-preview.dto';
import { MyPendingManualDepositItemDto } from './dto/my-pending-manual-deposit-item.dto';
import { PendingDepositItemDto } from './dto/pending-deposit-item.dto';
import { RejectManualDepositDto } from './dto/reject-manual-deposit.dto';
import { GroupFinanceService } from './group-finance.service';
import { GroupLoansService } from './group-loans.service';
import { RejectLoanApplicationDto } from './dto/reject-loan-application.dto';
import {
  ExtendLoanDto,
  IssueFineDto,
  ListFinesQueryDto,
  ManualDisbursementDto,
  GuaranteeResponseDto,
  ReasonDto,
} from './dto/finance-actions.dto';
import { FinesService } from './fines.service';
import { LoanExtrasService } from './loan-extras.service';
import { FinanceJobsService } from './finance-jobs.service';

@ApiTags('group-finance')
@ApiBearerAuth('JWT-auth')
@Controller('groups/:groupId/finance')
export class GroupFinanceController {
  constructor(
    private readonly groupFinance: GroupFinanceService,
    private readonly groupLoans: GroupLoansService,
    private readonly fines: FinesService,
    private readonly jobs: FinanceJobsService,
    private readonly loanExtras: LoanExtrasService,
  ) {}

  @Get('deposit-preview')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({
    summary:
      'Amount breakdown for a deposit (contribution, fines, installment)',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiOkResponse({ type: DepositPreviewResponseDto })
  @ApiNotFoundResponse({ description: 'Group not found' })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  depositPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Query('includeLoan', new ParseBoolPipe({ optional: true }))
    includeLoan?: boolean,
  ) {
    return this.groupFinance.getDepositPreview(user.id, groupId, {
      includeLoan,
    });
  }

  @Post('deposits')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({
    summary:
      'Record a deposit (MoMo or manual); validates against contribution rules',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiCreatedResponse({ description: 'Deposit recorded' })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  createDeposit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Body() dto: CreateDepositDto,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    return this.groupFinance.createDeposit(user.id, groupId, {
      amount: dto.amount,
      paymentMethod: dto.paymentMethod,
      phone: dto.phone,
      proofImageUrl: dto.proofImageUrl,
      memberLoanId: dto.memberLoanId,
      includeLoanRepayment: dto.includeLoanRepayment,
      earlyPayoff: dto.earlyPayoff,
      idempotencyKey: dto.idempotencyKey ?? idempotencyHeader,
    });
  }

  @Get('deposits/my-pending')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({
    summary:
      'Your own manual bank transfers awaiting group admin proof review (read-only). MoMo is confirmed when recorded.',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiOkResponse({ type: [MyPendingManualDepositItemDto] })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  getMyPendingManualDeposits(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
  ) {
    return this.groupFinance.getMyPendingManualDeposits(user.id, groupId);
  }

  @Get('deposits/pending')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({
    summary:
      'Manual bank transfers with proof pending review (group admin or treasurer).',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiOkResponse({ type: [PendingDepositItemDto] })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  listPendingManualDeposits(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
  ) {
    return this.groupFinance.listPendingManualDeposits(user.id, groupId);
  }

  @Post('deposits/:depositId/confirm')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({
    summary:
      'Confirm a manual bank deposit after proof review (group admin or treasurer; applies amounts to contributions or loan)',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'depositId', type: String })
  @ApiOkResponse({ description: 'Deposit confirmed; member emailed' })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  confirmManualDeposit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('depositId') depositId: string,
  ) {
    return this.groupFinance.confirmManualDeposit(user.id, groupId, depositId);
  }

  @Post('deposits/:depositId/reject')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({
    summary:
      'Reject a manual bank deposit (group admin or treasurer); member is notified by email',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'depositId', type: String })
  @ApiOkResponse({ description: 'Deposit rejected; member emailed' })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  rejectManualDeposit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('depositId') depositId: string,
    @Body() dto: RejectManualDepositDto,
  ) {
    return this.groupFinance.rejectManualDeposit(
      user.id,
      groupId,
      depositId,
      dto.reason,
    );
  }

  @Get('loan-request-preview')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({
    summary:
      'Eligibility and caps for a loan from group loan rules and member contributions',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiOkResponse({ type: LoanRequestPreviewResponseDto })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  loanRequestPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Query('topUpOfLoanId') topUpOfLoanId?: string,
  ) {
    return this.groupFinance.getLoanRequestPreview(user.id, groupId, {
      topUpOfLoanId: topUpOfLoanId?.trim() || undefined,
    });
  }

  @Post('loan-applications')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({ summary: 'Submit a loan request within configured limits' })
  @ApiParam({ name: 'groupId', type: String })
  @ApiCreatedResponse({ description: 'Application created' })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  createLoanApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Body() dto: CreateLoanApplicationDto,
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    return this.groupFinance.createLoanApplication(user.id, groupId, {
      ...dto,
      idempotencyKey: dto.idempotencyKey ?? idempotencyHeader,
    });
  }

  @Get('loan-repayment-preview')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({
    summary:
      'Amount due to repay a specific member loan (group must match the loan)',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiOkResponse({
    description:
      'Same shape as deposit preview with installment = loan balance',
  })
  loanRepaymentPreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Query('memberLoanId') memberLoanId: string,
  ) {
    if (!memberLoanId?.trim()) {
      return { configured: false, message: 'memberLoanId is required' };
    }
    return this.groupLoans.getLoanRepaymentPreviewForMember(
      user.id,
      groupId,
      memberLoanId.trim(),
    );
  }

  @Get('loan-applications')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({
    summary:
      'List loan applications for this group (group admin and treasurer; dual approval required to disburse)',
  })
  @ApiParam({ name: 'groupId', type: String })
  listLoanApplications(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
  ) {
    return this.groupLoans.listLoanApplicationsForGroup(user.id, groupId);
  }

  @Get('member-loans')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({ summary: 'Active and historical member loans in this group' })
  @ApiParam({ name: 'groupId', type: String })
  listMemberLoans(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
  ) {
    return this.groupLoans.listMemberLoansForGroup(user.id, groupId);
  }

  @Post('loan-applications/:applicationId/approve')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({
    summary:
      'Record your approval as group admin or treasurer; loan disburses when both have approved',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'applicationId', type: String })
  approveLoanApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('applicationId') applicationId: string,
  ) {
    return this.groupLoans.approveLoanApplication(
      user.id,
      groupId,
      applicationId,
    );
  }

  @Post('loan-applications/:applicationId/reject')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({ summary: 'Reject a pending loan (either role)' })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'applicationId', type: String })
  rejectLoanApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('applicationId') applicationId: string,
    @Body() dto: RejectLoanApplicationDto,
  ) {
    return this.groupLoans.rejectLoanApplication(
      user.id,
      groupId,
      applicationId,
      dto.reason,
    );
  }

  // ── deposit status ──────────────────────────────────────────────────────

  @Get('deposits/:depositId')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({
    summary:
      'Deposit status and allocation (own deposit, or any for leaders). Refreshes a pending MoMo payment from MTN.',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'depositId', type: String })
  getDeposit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('depositId') depositId: string,
  ) {
    return this.groupFinance.getDepositStatus(user.id, groupId, depositId);
  }

  @Get('cash-position')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({
    summary: 'Group cash in (confirmed deposits), loans out and available cash',
  })
  @ApiParam({ name: 'groupId', type: String })
  cashPosition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
  ) {
    return this.groupFinance.getCashPosition(user.id, groupId);
  }

  // ── fines ───────────────────────────────────────────────────────────────

  @Get('fines')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({ summary: 'Fines (leaders: all members; members: their own)' })
  @ApiParam({ name: 'groupId', type: String })
  listFines(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Query() q: ListFinesQueryDto,
  ) {
    return this.fines.list(user.id, groupId, q);
  }

  @Post('fines')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({ summary: 'Issue a fine to a member (not to yourself)' })
  @ApiParam({ name: 'groupId', type: String })
  issueFine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Body() dto: IssueFineDto,
  ) {
    return this.fines.issue(user.id, groupId, dto);
  }

  @Post('fines/:fineId/waive')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({ summary: 'Waive an open fine (not your own)' })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'fineId', type: String })
  waiveFine(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('fineId') fineId: string,
    @Body() dto: ReasonDto,
  ) {
    return this.fines.waive(user.id, groupId, fineId, dto.reason);
  }

  // ── loan actions ────────────────────────────────────────────────────────

  @Post('member-loans/:memberLoanId/write-off')
  @GroupRole(RoleName.GROUP_ADMIN)
  @ApiOperation({
    summary: 'Write off an active/defaulted loan (group admin; not your own)',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'memberLoanId', type: String })
  writeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('memberLoanId') memberLoanId: string,
    @Body() dto: ReasonDto,
  ) {
    return this.groupLoans.writeOffLoan(
      user.id,
      groupId,
      memberLoanId,
      dto.reason,
    );
  }

  @Post('member-loans/:memberLoanId/extend')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({
    summary:
      'Extend the due date (restructure); a defaulted loan becomes active again',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'memberLoanId', type: String })
  extend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('memberLoanId') memberLoanId: string,
    @Body() dto: ExtendLoanDto,
  ) {
    return this.groupLoans.extendLoan(user.id, groupId, memberLoanId, dto);
  }

  @Post('member-loans/:memberLoanId/disbursement/retry')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({ summary: 'Retry a failed MTN MoMo loan payout' })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'memberLoanId', type: String })
  retryDisbursement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('memberLoanId') memberLoanId: string,
  ) {
    return this.groupLoans.retryDisbursement(user.id, groupId, memberLoanId);
  }

  @Post('member-loans/:memberLoanId/disbursement/manual')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({
    summary: 'Record a cash / bank payout (loan term restarts from now)',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'memberLoanId', type: String })
  manualDisbursement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('memberLoanId') memberLoanId: string,
    @Body() dto: ManualDisbursementDto,
  ) {
    return this.groupLoans.recordManualDisbursement(
      user.id,
      groupId,
      memberLoanId,
      dto,
    );
  }

  // ── scheduler (manual trigger) ──────────────────────────────────────────

  @Post('jobs/run')
  @GroupRole(RoleName.GROUP_ADMIN)
  @ApiOperation({
    summary:
      'Run the daily money jobs now for this group (generate periods, mark late, fines, reminders, loan penalties). Idempotent.',
  })
  @ApiParam({ name: 'groupId', type: String })
  runJobs(@Param('groupId') groupId: string) {
    return this.jobs.runDaily(groupId);
  }

  // ── loans: applications, guarantors, statements (msfts §4) ──────────────

  @Post('loan-applications/:applicationId/cancel')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({ summary: 'Withdraw your own pending loan application' })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'applicationId', type: String })
  cancelLoanApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('applicationId') applicationId: string,
  ) {
    return this.loanExtras.cancelApplication(user.id, groupId, applicationId);
  }

  @Get('guarantees/mine')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({ summary: 'Guarantees other members asked of you' })
  @ApiParam({ name: 'groupId', type: String })
  myGuarantees(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
  ) {
    return this.loanExtras.myGuarantees(user.id, groupId);
  }

  @Post('guarantees/:guaranteeId/respond')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({
    summary:
      'Accept or decline guaranteeing a loan (accepting locks that much of your savings)',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'guaranteeId', type: String })
  respondGuarantee(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('guaranteeId') guaranteeId: string,
    @Body() dto: GuaranteeResponseDto,
  ) {
    return this.loanExtras.respond(user.id, groupId, guaranteeId, dto.accept);
  }

  @Post('member-loans/:memberLoanId/guarantees/call')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER)
  @ApiOperation({
    summary:
      'Defaulted / written-off loan: guarantors owe their share of the balance',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'memberLoanId', type: String })
  callGuarantees(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('memberLoanId') memberLoanId: string,
  ) {
    return this.loanExtras.callGuarantees(user.id, groupId, memberLoanId);
  }

  @Get('member-loans/:memberLoanId/statement')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({
    summary:
      'Loan statement: schedule (amortization), payments, payout, guarantors',
  })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'memberLoanId', type: String })
  loanStatement(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('memberLoanId') memberLoanId: string,
  ) {
    return this.loanExtras.statement(user.id, groupId, memberLoanId);
  }

  @Get('member-loans/:memberLoanId/statement.pdf')
  @GroupRole(RoleName.GROUP_ADMIN, RoleName.TREASURER, RoleName.MEMBER)
  @ApiOperation({ summary: 'Loan statement as PDF' })
  @ApiParam({ name: 'groupId', type: String })
  @ApiParam({ name: 'memberLoanId', type: String })
  async loanStatementPdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('groupId') groupId: string,
    @Param('memberLoanId') memberLoanId: string,
    @Res() res: Response,
  ) {
    const pdf = await this.loanExtras.statementPdf(
      user.id,
      groupId,
      memberLoanId,
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="loan-statement-${memberLoanId}.pdf"`,
    );
    res.send(pdf);
  }
}
