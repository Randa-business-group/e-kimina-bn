import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CurrentUser } from '../decorators/current-user.decorator';
import { AccountingService } from './accounting.service';
import { CyclesService } from './cycles.service';
import {
  AdjustmentDto,
  ContributionAmountDto,
  CreateCycleDto,
  CreateExpenseDto,
  CycleQueryDto,
  ExpenseQueryDto,
  GenerateRotationDto,
  LedgerQueryDto,
  PaymentRecordDto,
  ReasonBodyDto,
  RotationPayDto,
  SocialFundConfigDto,
  SocialPayoutQueryDto,
  SocialPayoutRequestDto,
  SwapRequestDto,
  SwapResponseDto,
  UpdateCycleDto,
} from './dto/accounting.dto';
import { ExpensesService } from './expenses.service';
import { RotationService } from './rotation.service';
import { SocialFundService } from './social-fund.service';

/**
 * Group accounting (msfts §2): ledger, balances, statements, cycles & share-out, expenses,
 * social fund, rotating payouts. Role checks live in the services (AccountingAccessService).
 */
@ApiTags('group-accounting')
@ApiBearerAuth('JWT-auth')
@ApiParam({ name: 'groupId', type: String })
@Controller('groups/:groupId/accounting')
export class GroupAccountingController {
  constructor(
    private readonly accounting: AccountingService,
    private readonly cycles: CyclesService,
    private readonly expenses: ExpensesService,
    private readonly social: SocialFundService,
    private readonly rotation: RotationService,
  ) {}

  // ── balances / ledger / statements ──────────────────────────────────────

  @Get('summary')
  @ApiOperation({
    summary:
      'Group balance dashboard (cash per fund, loans, income, arrears). Any member.',
  })
  summary(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Query() q: CycleQueryDto,
  ) {
    return this.accounting.summary(u.id, g, q.cycleId);
  }

  @Get('ledger')
  @ApiOperation({
    summary:
      'Cash book, paged and filterable (leaders, super admin read-only).',
  })
  ledger(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Query() q: LedgerQueryDto,
  ) {
    return this.accounting.ledger(u.id, g, q);
  }

  @Post('ledger/adjustments')
  @ApiOperation({
    summary: 'Leaders: manual correction or member opening balance (audited).',
  })
  adjust(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Body() dto: AdjustmentDto,
  ) {
    return this.accounting.adjust(u.id, g, dto);
  }

  @Get('statements/me')
  @ApiOperation({
    summary:
      'Your balance: savings, social fund, fines, loans, projected share-out.',
  })
  myStatement(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
  ) {
    return this.accounting.statement(u.id, g, u.id);
  }

  @Get('statements/:userId')
  @ApiOperation({ summary: 'A member balance (leaders).' })
  statement(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('userId') userId: string,
  ) {
    return this.accounting.statement(u.id, g, userId);
  }

  @Patch('members/:userId/contribution-amount')
  @ApiOperation({
    summary:
      'Group admin: per-member savings amount (null = default); future periods follow.',
  })
  contributionAmount(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('userId') userId: string,
    @Body() dto: ContributionAmountDto,
  ) {
    return this.accounting.setContributionAmount(u.id, g, userId, dto.amount);
  }

  // ── cycles & share-out ──────────────────────────────────────────────────

  @Get('cycles')
  listCycles(@CurrentUser() u: AuthenticatedUser, @Param('groupId') g: string) {
    return this.cycles.list(u.id, g);
  }

  @Post('cycles')
  @ApiOperation({
    summary:
      'Group admin: start a savings cycle (existing rows in the range are tagged).',
  })
  createCycle(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Body() dto: CreateCycleDto,
  ) {
    return this.cycles.create(u.id, g, dto);
  }

  @Patch('cycles/:cycleId')
  updateCycle(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('cycleId') c: string,
    @Body() dto: UpdateCycleDto,
  ) {
    return this.cycles.update(u.id, g, c, dto);
  }

  @Get('cycles/:cycleId/share-out')
  @ApiOperation({
    summary:
      'Share-out (live preview, or final for a closed cycle). Members see their own line.',
  })
  shareOut(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('cycleId') c: string,
  ) {
    return this.cycles.shareOut(u.id, g, c);
  }

  @Post('cycles/:cycleId/share-out/prepare')
  @ApiOperation({
    summary: 'Leader: freeze the cycle and prepare the share-out for approval.',
  })
  prepare(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('cycleId') c: string,
  ) {
    return this.cycles.prepare(u.id, g, c);
  }

  @Post('cycles/:cycleId/share-out/cancel')
  cancelPrepare(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('cycleId') c: string,
  ) {
    return this.cycles.cancelPreparation(u.id, g, c);
  }

  @Post('cycles/:cycleId/share-out/approve')
  @ApiOperation({
    summary:
      'Other leader (one of them the admin): settle debts from shares and close the cycle.',
  })
  approve(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('cycleId') c: string,
  ) {
    return this.cycles.approve(u.id, g, c);
  }

  @Post('cycles/:cycleId/share-outs/pay-all')
  payAll(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('cycleId') c: string,
    @Body() dto: PaymentRecordDto,
  ) {
    return this.cycles.payAll(u.id, g, c, dto);
  }

  @Post('cycles/:cycleId/share-outs/:shareOutId/pay')
  payShareOut(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('cycleId') c: string,
    @Param('shareOutId') s: string,
    @Body() dto: PaymentRecordDto,
  ) {
    return this.cycles.pay(u.id, g, c, s, dto);
  }

  @Post('cycles/:cycleId/share-outs/:shareOutId/carry-over')
  @ApiOperation({
    summary:
      'Reinvest the net share as opening balance of the next (active) cycle.',
  })
  carryOver(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('cycleId') c: string,
    @Param('shareOutId') s: string,
  ) {
    return this.cycles.carryOver(u.id, g, c, s);
  }

  // ── expenses ────────────────────────────────────────────────────────────

  @Get('expenses')
  listExpenses(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Query() q: ExpenseQueryDto,
  ) {
    return this.expenses.list(u.id, g, q);
  }

  @Post('expenses')
  @ApiOperation({
    summary: 'Leader: record an expense (another leader must approve it).',
  })
  createExpense(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Body() dto: CreateExpenseDto,
  ) {
    return this.expenses.create(u.id, g, dto);
  }

  @Post('expenses/:expenseId/approve')
  approveExpense(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('expenseId') e: string,
  ) {
    return this.expenses.approve(u.id, g, e);
  }

  @Post('expenses/:expenseId/reject')
  rejectExpense(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('expenseId') e: string,
    @Body() dto: ReasonBodyDto,
  ) {
    return this.expenses.reject(u.id, g, e, dto.reason);
  }

  @Post('expenses/:expenseId/cancel')
  cancelExpense(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('expenseId') e: string,
  ) {
    return this.expenses.cancel(u.id, g, e);
  }

  // ── social fund ─────────────────────────────────────────────────────────

  @Get('social-fund')
  @ApiOperation({ summary: 'Social fund rules and balance (any member).' })
  socialOverview(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
  ) {
    return this.social.getOverview(u.id, g);
  }

  @Put('social-fund/config')
  @ApiOperation({
    summary:
      'Leaders: create or update the social fund rules (generates SOCIAL periods).',
  })
  socialConfig(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Body() dto: SocialFundConfigDto,
  ) {
    return this.social.upsertConfig(u.id, g, dto);
  }

  @Get('social-fund/payouts')
  socialPayouts(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Query() q: SocialPayoutQueryDto,
  ) {
    return this.social.listPayouts(u.id, g, q);
  }

  @Post('social-fund/payouts')
  @ApiOperation({
    summary:
      'Request a payout (members for themselves, leaders for any member).',
  })
  requestSocial(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Body() dto: SocialPayoutRequestDto,
  ) {
    return this.social.requestPayout(u.id, g, dto);
  }

  @Post('social-fund/payouts/:payoutId/approve')
  approveSocial(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('payoutId') p: string,
  ) {
    return this.social.approve(u.id, g, p);
  }

  @Post('social-fund/payouts/:payoutId/reject')
  rejectSocial(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('payoutId') p: string,
    @Body() dto: ReasonBodyDto,
  ) {
    return this.social.reject(u.id, g, p, dto.reason);
  }

  @Post('social-fund/payouts/:payoutId/cancel')
  cancelSocial(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('payoutId') p: string,
  ) {
    return this.social.cancel(u.id, g, p);
  }

  @Post('social-fund/payouts/:payoutId/pay')
  paySocial(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('payoutId') p: string,
    @Body() dto: PaymentRecordDto,
  ) {
    return this.social.markPaid(u.id, g, p, dto);
  }

  // ── rotating payouts ────────────────────────────────────────────────────

  @Get('rotation')
  rotationList(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
  ) {
    return this.rotation.list(u.id, g);
  }

  @Post('rotation/generate')
  @ApiOperation({
    summary:
      'Group admin: plan the payout order on the next due dates (ROTATING mode).',
  })
  rotationGenerate(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Body() dto: GenerateRotationDto,
  ) {
    return this.rotation.generate(u.id, g, dto);
  }

  @Post('rotation/slots/:slotId/pay')
  rotationPay(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('slotId') s: string,
    @Body() dto: RotationPayDto,
  ) {
    return this.rotation.pay(u.id, g, s, dto);
  }

  @Post('rotation/slots/:slotId/skip')
  rotationSkip(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('slotId') s: string,
    @Body() dto: ReasonBodyDto,
  ) {
    return this.rotation.skip(u.id, g, s, dto.reason);
  }

  @Post('rotation/swaps')
  @ApiOperation({
    summary: 'Offer your upcoming turn in exchange for another member’s.',
  })
  rotationSwap(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Body() dto: SwapRequestDto,
  ) {
    return this.rotation.requestSwap(u.id, g, dto);
  }

  @Post('rotation/swaps/:swapId/respond')
  rotationRespond(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('swapId') s: string,
    @Body() dto: SwapResponseDto,
  ) {
    return this.rotation.respondSwap(u.id, g, s, dto.accept);
  }

  @Post('rotation/swaps/:swapId/cancel')
  rotationCancelSwap(
    @CurrentUser() u: AuthenticatedUser,
    @Param('groupId') g: string,
    @Param('swapId') s: string,
  ) {
    return this.rotation.cancelSwap(u.id, g, s);
  }
}
