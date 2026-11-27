import {
  Body,
  Controller,
  Delete,
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
import { ConstitutionService } from './constitution.service';
import {
  AcceptConstitutionDto,
  AttendanceDto,
  ChangeRoleDto,
  ConstitutionDto,
  ExitQueryDto,
  GovernanceSettingsDto,
  IssueMeetingFinesDto,
  MeetingDto,
  MeetingQueryDto,
  MemberProfileDto,
  MinutesDto,
  OptionalReasonDto,
  PollDto,
  PollQueryDto,
  ReplaceTreasurerDto,
  RequiredReasonDto,
  SettleExitDto,
  TransferAdminDto,
  UpdateMeetingDto,
  VoteDto,
} from './dto/governance.dto';
import { ExitService } from './exit.service';
import { MeetingsService } from './meetings.service';
import { MembershipService } from './membership.service';
import { PollsService } from './polls.service';

type U = AuthenticatedUser;

/**
 * Members and governance (msfts §3): roles, join requests, exits, settings, profiles,
 * invitations, meetings, constitution, votes. Role checks live in the services.
 */
@ApiTags('group-governance')
@ApiBearerAuth('JWT-auth')
@ApiParam({ name: 'groupId', type: String })
@Controller('groups/:groupId/governance')
export class GroupGovernanceController {
  constructor(
    private readonly membership: MembershipService,
    private readonly exits: ExitService,
    private readonly meetings: MeetingsService,
    private readonly constitution: ConstitutionService,
    private readonly polls: PollsService,
  ) {}

  // ── roles ───────────────────────────────────────────────────────────────

  @Patch('members/:userId/role')
  @ApiOperation({
    summary:
      'Group admin: promote / demote a member (the group keeps ≥ 1 admin). Several admins/treasurers allowed.',
  })
  changeRole(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('userId') userId: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.membership.changeRole(u.id, g, userId, dto.role);
  }

  @Post('treasurer')
  @ApiOperation({
    summary:
      'Group admin: replace the treasurer (current treasurer(s) get another role).',
  })
  replaceTreasurer(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Body() dto: ReplaceTreasurerDto,
  ) {
    return this.membership.replaceTreasurer(
      u.id,
      g,
      dto.userId,
      dto.previousTreasurerRole,
    );
  }

  @Post('transfer-admin')
  @ApiOperation({
    summary: 'Group admin: hand the admin role to another member.',
  })
  transferAdmin(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Body() dto: TransferAdminDto,
  ) {
    return this.membership.transferAdmin(u.id, g, dto.userId, dto.myNewRole);
  }

  // ── settings ────────────────────────────────────────────────────────────

  @Get('settings')
  getSettings(@CurrentUser() u: U, @Param('groupId') g: string) {
    return this.membership.getSettings(u.id, g);
  }

  @Patch('settings')
  @ApiOperation({
    summary:
      'Group admin: member limits, join approval, co-signers, constitution rule, meeting fines.',
  })
  updateSettings(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Body() dto: GovernanceSettingsDto,
  ) {
    return this.membership.updateSettings(u.id, g, dto);
  }

  // ── join requests ───────────────────────────────────────────────────────

  @Get('join-requests')
  joinRequests(@CurrentUser() u: U, @Param('groupId') g: string) {
    return this.membership.listJoinRequests(u.id, g);
  }

  @Post('join-requests/:userId/approve')
  approveJoin(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('userId') userId: string,
  ) {
    return this.membership.approveJoin(u.id, g, userId);
  }

  @Post('join-requests/:userId/reject')
  rejectJoin(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('userId') userId: string,
    @Body() dto: OptionalReasonDto,
  ) {
    return this.membership.rejectJoin(u.id, g, userId, dto.reason);
  }

  // ── exits ───────────────────────────────────────────────────────────────

  @Get('exits/preview')
  @ApiOperation({
    summary: 'What you would get back if you left now (savings − debts).',
  })
  exitPreview(@CurrentUser() u: U, @Param('groupId') g: string) {
    return this.exits.preview(u.id, g);
  }

  @Get('exits')
  listExits(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Query() q: ExitQueryDto,
  ) {
    return this.exits.list(u.id, g, q.status);
  }

  @Post('exits')
  @ApiOperation({ summary: 'Ask to leave the group.' })
  requestExit(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Body() dto: RequiredReasonDto,
  ) {
    return this.exits.request(u.id, g, dto.reason);
  }

  @Post('exits/:exitId/settle')
  @ApiOperation({
    summary: 'Leader: offset debts, refund savings, membership EXITED.',
  })
  settleExit(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('exitId') id: string,
    @Body() dto: SettleExitDto,
  ) {
    return this.exits.settle(u.id, g, id, dto);
  }

  @Post('exits/:exitId/reject')
  rejectExit(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('exitId') id: string,
    @Body() dto: RequiredReasonDto,
  ) {
    return this.exits.reject(u.id, g, id, dto.reason);
  }

  @Post('exits/:exitId/cancel')
  cancelExit(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('exitId') id: string,
  ) {
    return this.exits.cancel(u.id, g, id);
  }

  // ── profiles ────────────────────────────────────────────────────────────

  @Get('profiles')
  @ApiOperation({
    summary: 'Leaders: all member profiles (next of kin, beneficiary, ID).',
  })
  profiles(@CurrentUser() u: U, @Param('groupId') g: string) {
    return this.membership.listProfiles(u.id, g);
  }

  @Get('profiles/me')
  myProfile(@CurrentUser() u: U, @Param('groupId') g: string) {
    return this.membership.getProfile(u.id, g, u.id);
  }

  @Put('profiles/me')
  updateMyProfile(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Body() dto: MemberProfileDto,
  ) {
    return this.membership.upsertMyProfile(u.id, g, dto);
  }

  @Get('profiles/:userId')
  profile(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('userId') userId: string,
  ) {
    return this.membership.getProfile(u.id, g, userId);
  }

  // ── invitations ─────────────────────────────────────────────────────────

  @Get('invitations')
  @ApiOperation({
    summary: 'Group admin: pending member / treasurer invitations.',
  })
  invitations(@CurrentUser() u: U, @Param('groupId') g: string) {
    return this.membership.listInvitations(u.id, g);
  }

  @Post('invitations/:invitationId/resend')
  resendInvitation(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('invitationId') id: string,
  ) {
    return this.membership.resendInvitation(u.id, g, id);
  }

  @Delete('invitations/:invitationId')
  revokeInvitation(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('invitationId') id: string,
  ) {
    return this.membership.revokeInvitation(u.id, g, id);
  }

  // ── meetings ────────────────────────────────────────────────────────────

  @Get('meetings')
  listMeetings(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Query() q: MeetingQueryDto,
  ) {
    return this.meetings.list(u.id, g, q.scope);
  }

  @Post('meetings')
  createMeeting(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Body() dto: MeetingDto,
  ) {
    return this.meetings.create(u.id, g, dto);
  }

  @Get('meetings/:meetingId')
  getMeeting(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('meetingId') id: string,
  ) {
    return this.meetings.get(u.id, g, id);
  }

  @Patch('meetings/:meetingId')
  updateMeeting(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('meetingId') id: string,
    @Body() dto: UpdateMeetingDto,
  ) {
    return this.meetings.update(u.id, g, id, dto);
  }

  @Post('meetings/:meetingId/cancel')
  cancelMeeting(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('meetingId') id: string,
    @Body() dto: RequiredReasonDto,
  ) {
    return this.meetings.cancel(u.id, g, id, dto.reason);
  }

  @Put('meetings/:meetingId/attendance')
  @ApiOperation({
    summary: 'Leader: record attendance (PRESENT / LATE / ABSENT / EXCUSED).',
  })
  attendance(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('meetingId') id: string,
    @Body() dto: AttendanceDto,
  ) {
    return this.meetings.recordAttendance(u.id, g, id, dto.entries);
  }

  @Post('meetings/:meetingId/fines')
  @ApiOperation({ summary: 'Leader: issue absence / lateness fines (once).' })
  meetingFines(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('meetingId') id: string,
    @Body() dto: IssueMeetingFinesDto,
  ) {
    return this.meetings.issueFines(u.id, g, id, dto.markMissingAbsent ?? true);
  }

  @Put('meetings/:meetingId/minutes')
  minutes(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('meetingId') id: string,
    @Body() dto: MinutesDto,
  ) {
    return this.meetings.publishMinutes(u.id, g, id, dto);
  }

  // ── constitution ────────────────────────────────────────────────────────

  @Get('constitution')
  @ApiOperation({
    summary:
      'Current rules, whether you accepted them (leaders also see who has not).',
  })
  constitutionCurrent(@CurrentUser() u: U, @Param('groupId') g: string) {
    return this.constitution.current(u.id, g);
  }

  @Get('constitution/history')
  constitutionHistory(@CurrentUser() u: U, @Param('groupId') g: string) {
    return this.constitution.history(u.id, g);
  }

  @Post('constitution')
  @ApiOperation({
    summary:
      'Group admin: publish a new version (members must accept it again).',
  })
  publishConstitution(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Body() dto: ConstitutionDto,
  ) {
    return this.constitution.publish(u.id, g, dto);
  }

  @Post('constitution/accept')
  acceptConstitution(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Body() dto: AcceptConstitutionDto,
  ) {
    return this.constitution.accept(u.id, g, dto.version);
  }

  // ── votes ───────────────────────────────────────────────────────────────

  @Get('polls')
  listPolls(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Query() q: PollQueryDto,
  ) {
    return this.polls.list(u.id, g, q.status);
  }

  @Post('polls')
  @ApiOperation({
    summary:
      'Leader: open a vote (GENERAL, ROLE_CHANGE, REMOVE_MEMBER, RULE_CHANGE).',
  })
  createPoll(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Body() dto: PollDto,
  ) {
    return this.polls.create(u.id, g, dto);
  }

  @Get('polls/:pollId')
  getPoll(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('pollId') id: string,
  ) {
    return this.polls.get(u.id, g, id);
  }

  @Post('polls/:pollId/vote')
  vote(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('pollId') id: string,
    @Body() dto: VoteDto,
  ) {
    return this.polls.vote(u.id, g, id, dto.optionIndex);
  }

  @Post('polls/:pollId/close')
  @ApiOperation({
    summary:
      'Close early; passed ROLE_CHANGE / REMOVE_MEMBER votes are applied.',
  })
  closePoll(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('pollId') id: string,
  ) {
    return this.polls.close(u.id, g, id);
  }

  @Post('polls/:pollId/cancel')
  cancelPoll(
    @CurrentUser() u: U,
    @Param('groupId') g: string,
    @Param('pollId') id: string,
  ) {
    return this.polls.cancel(u.id, g, id);
  }
}
