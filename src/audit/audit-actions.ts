import type { PrismaService } from '../prisma/prisma.service';

type Params = Record<string, string | undefined>;
type Loader = (
  prisma: PrismaService,
  p: Params,
  body: Record<string, unknown>,
) => Promise<unknown>;

export type AuditActionDef = {
  /** Stable action name shown in the audit log, e.g. `deposit.confirm`. */
  action: string;
  entityType?: string;
  /** Route param holding the entity id (defaults to the last non-group param). */
  idParam?: string;
  /** Snapshot taken before and after the handler; the log keeps only changed fields. */
  load?: Loader;
};

const membership: Loader = (prisma, p) => {
  const userId = p.userId ?? p.memberUserId;
  if (!p.groupId || !userId) return Promise.resolve(null);
  return prisma.userGroup.findUnique({
    where: { userId_groupId: { userId, groupId: p.groupId } },
    select: {
      membershipStatus: true,
      customContributionAmount: true,
      role: { select: { name: true } },
    },
  });
};

const leaders: Loader = async (prisma, p) => {
  if (!p.groupId) return null;
  const rows = await prisma.userGroup.findMany({
    where: {
      groupId: p.groupId,
      membershipStatus: 'ACTIVE',
      role: { name: { in: ['GROUP_ADMIN', 'TREASURER'] } },
    },
    select: { userId: true, role: { select: { name: true } } },
    orderBy: { userId: 'asc' },
  });
  return {
    admins: rows
      .filter((r) => r.role.name === 'GROUP_ADMIN')
      .map((r) => r.userId),
    treasurers: rows
      .filter((r) => r.role.name === 'TREASURER')
      .map((r) => r.userId),
  };
};

const group: Loader = (prisma, p) =>
  p.groupId
    ? prisma.group.findUnique({
        where: { id: p.groupId },
        select: {
          name: true,
          description: true,
          isPublic: true,
          maxMembers: true,
          minMembers: true,
          isVerified: true,
          verificationStatus: true,
          verificationRejectionReason: true,
          deletedAt: true,
          deletionReason: true,
          joinRequiresApproval: true,
          loanApprovalsRequired: true,
          loanRequireAdminAndTreasurer: true,
          expenseApprovalsRequired: true,
          constitutionRequired: true,
          defaultAbsenceFine: true,
          defaultLateArrivalFine: true,
        },
      })
    : Promise.resolve(null);

const byId =
  <K extends string>(
    param: K,
    find: (prisma: PrismaService, id: string) => Promise<unknown>,
  ): Loader =>
  (prisma, p) => {
    const id = p[param];
    return id ? find(prisma, id) : Promise.resolve(null);
  };

const deposit = byId('depositId', (prisma, id) =>
  prisma.depositRecord.findUnique({
    where: { id },
    select: {
      status: true,
      amount: true,
      userId: true,
      reviewedByUserId: true,
      reviewedAt: true,
      rejectionReason: true,
    },
  }),
);
const loanApp = byId('applicationId', (prisma, id) =>
  prisma.loanApplication.findUnique({ where: { id } }),
);
const memberLoan = byId('memberLoanId', (prisma, id) =>
  prisma.memberLoan.findUnique({ where: { id } }),
);
const fine = byId('fineId', (prisma, id) =>
  prisma.fine.findUnique({ where: { id } }),
);
const expense = byId('expenseId', (prisma, id) =>
  prisma.expense.findUnique({ where: { id } }),
);
const socialPayout = byId('payoutId', (prisma, id) =>
  prisma.socialPayout.findUnique({ where: { id } }),
);
const cycle = byId('cycleId', (prisma, id) =>
  prisma.groupCycle.findUnique({ where: { id } }),
);
const shareOut = byId('shareOutId', (prisma, id) =>
  prisma.shareOut.findUnique({ where: { id } }),
);
const userSecurity = byId('id', (prisma, id) =>
  prisma.user.findUnique({
    where: { id },
    select: {
      emailVerified: true,
      suspendedAt: true,
      suspensionReason: true,
      failedLoginAttempts: true,
      lockedUntil: true,
      sessionVersion: true,
    },
  }),
);
const paymentAccount: Loader = (prisma, p) =>
  p.groupId
    ? prisma.groupPaymentAccount.findUnique({
        where: { groupId: p.groupId },
        select: {
          accountName: true,
          msisdn: true,
          isActive: true,
          collectionUserId: true,
          disbursementUserId: true,
          updatedAt: true,
        },
      })
    : Promise.resolve(null);

/** Keyed by `ControllerClass.handler`. Unlisted routes get a derived name. */
export const AUDIT_ACTIONS: Record<string, AuditActionDef> = {
  // auth
  'AuthController.register': { action: 'auth.register', entityType: 'User' },
  'AuthController.verifyEmail': {
    action: 'auth.verify_email',
    entityType: 'User',
  },
  'AuthController.resendVerification': {
    action: 'auth.resend_verification',
    entityType: 'User',
  },
  'AuthController.forgotPassword': {
    action: 'auth.forgot_password',
    entityType: 'User',
  },
  'AuthController.verifyResetOtp': {
    action: 'auth.reset_code_verified',
    entityType: 'User',
  },
  'AuthController.completePasswordReset': {
    action: 'auth.password_reset',
    entityType: 'User',
  },
  'AuthController.login': { action: 'auth.login', entityType: 'User' },

  // configuration
  'ContributionConfigController.upsert': {
    action: 'config.contribution.update',
    entityType: 'ContributionConfig',
    load: (prisma, p) =>
      prisma.contributionConfig.findUnique({ where: { groupId: p.groupId } }),
  },
  'LoanConfigController.upsert': {
    action: 'config.loan.update',
    entityType: 'LoanConfig',
    load: (prisma, p) =>
      prisma.loanConfig.findUnique({ where: { groupId: p.groupId } }),
  },
  'GroupAccountingController.socialConfig': {
    action: 'config.social_fund.update',
    entityType: 'SocialFundConfig',
    load: (prisma, p) =>
      prisma.socialFundConfig.findUnique({ where: { groupId: p.groupId } }),
  },
  'GroupGovernanceController.updateSettings': {
    action: 'config.governance.update',
    entityType: 'Group',
    load: group,
  },
  'GroupsController.updateGroup': {
    action: 'group.update',
    entityType: 'Group',
    load: group,
  },
  'GroupsController.togglePublic': {
    action: 'group.toggle_public',
    entityType: 'Group',
    load: group,
  },

  // group lifecycle & verification
  'GroupsController.create': { action: 'group.create', entityType: 'Group' },
  'GroupsController.deleteGroup': {
    action: 'group.delete',
    entityType: 'Group',
    load: group,
  },
  'GroupsController.restore': {
    action: 'group.restore',
    entityType: 'Group',
    load: group,
  },
  'GroupsController.requestVerification': {
    action: 'group.verification.request',
    entityType: 'Group',
    load: group,
  },
  'GroupsController.verify': {
    action: 'group.verification.approve',
    entityType: 'Group',
    load: group,
  },
  'GroupsController.rejectVerification': {
    action: 'group.verification.reject',
    entityType: 'Group',
    load: group,
  },

  // members & roles
  'GroupsController.removeMember': {
    action: 'member.remove',
    entityType: 'Membership',
    idParam: 'memberUserId',
    load: membership,
  },
  'GroupsController.suspendMember': {
    action: 'member.suspend',
    entityType: 'Membership',
    idParam: 'memberUserId',
    load: membership,
  },
  'GroupsController.reactivateMember': {
    action: 'member.reactivate',
    entityType: 'Membership',
    idParam: 'memberUserId',
    load: membership,
  },
  'GroupsController.join': { action: 'member.join', entityType: 'Membership' },
  'GroupsController.inviteMember': {
    action: 'member.invite',
    entityType: 'Membership',
  },
  'GroupGovernanceController.changeRole': {
    action: 'member.role_change',
    entityType: 'Membership',
    idParam: 'userId',
    load: membership,
  },
  'GroupGovernanceController.replaceTreasurer': {
    action: 'member.treasurer_replace',
    entityType: 'Group',
    load: leaders,
  },
  'GroupGovernanceController.transferAdmin': {
    action: 'member.admin_transfer',
    entityType: 'Group',
    load: leaders,
  },
  'GroupGovernanceController.approveJoin': {
    action: 'member.join_approve',
    entityType: 'Membership',
    idParam: 'userId',
    load: membership,
  },
  'GroupGovernanceController.rejectJoin': {
    action: 'member.join_reject',
    entityType: 'Membership',
    idParam: 'userId',
    load: membership,
  },
  'GroupGovernanceController.settleExit': {
    action: 'member.exit_settle',
    entityType: 'ExitRequest',
  },
  'GroupAccountingController.contributionAmount': {
    action: 'member.contribution_amount',
    entityType: 'Membership',
    idParam: 'userId',
    load: membership,
  },

  // deposits & fines
  'GroupFinanceController.createDeposit': {
    action: 'deposit.create',
    entityType: 'DepositRecord',
  },
  'GroupFinanceController.confirmManualDeposit': {
    action: 'deposit.confirm',
    entityType: 'DepositRecord',
    load: deposit,
  },
  'GroupFinanceController.rejectManualDeposit': {
    action: 'deposit.reject',
    entityType: 'DepositRecord',
    load: deposit,
  },
  'GroupFinanceController.issueFine': {
    action: 'fine.issue',
    entityType: 'Fine',
  },
  'GroupFinanceController.waiveFine': {
    action: 'fine.waive',
    entityType: 'Fine',
    load: fine,
  },
  'ContributionsController.create': {
    action: 'contribution.create',
    entityType: 'Contribution',
  },
  'ContributionsController.update': {
    action: 'contribution.update',
    entityType: 'Contribution',
  },

  // loans
  'GroupFinanceController.createLoanApplication': {
    action: 'loan.apply',
    entityType: 'LoanApplication',
  },
  'GroupFinanceController.approveLoanApplication': {
    action: 'loan.approve',
    entityType: 'LoanApplication',
    load: loanApp,
  },
  'GroupFinanceController.rejectLoanApplication': {
    action: 'loan.reject',
    entityType: 'LoanApplication',
    load: loanApp,
  },
  'GroupFinanceController.cancelLoanApplication': {
    action: 'loan.cancel',
    entityType: 'LoanApplication',
    load: loanApp,
  },
  'GroupFinanceController.writeOff': {
    action: 'loan.write_off',
    entityType: 'MemberLoan',
    load: memberLoan,
  },
  'GroupFinanceController.extend': {
    action: 'loan.extend',
    entityType: 'MemberLoan',
    load: memberLoan,
  },
  'GroupFinanceController.retryDisbursement': {
    action: 'loan.disbursement_retry',
    entityType: 'MemberLoan',
    load: memberLoan,
  },
  'GroupFinanceController.manualDisbursement': {
    action: 'loan.disbursement_manual',
    entityType: 'MemberLoan',
    load: memberLoan,
  },
  'GroupFinanceController.callGuarantees': {
    action: 'loan.guarantees_call',
    entityType: 'MemberLoan',
    load: memberLoan,
  },
  'GroupFinanceController.respondGuarantee': {
    action: 'loan.guarantee_respond',
    entityType: 'LoanGuarantor',
  },

  // accounting
  'GroupAccountingController.adjust': {
    action: 'ledger.adjustment',
    entityType: 'LedgerEntry',
  },
  'GroupAccountingController.createCycle': {
    action: 'cycle.create',
    entityType: 'GroupCycle',
  },
  'GroupAccountingController.updateCycle': {
    action: 'cycle.update',
    entityType: 'GroupCycle',
    load: cycle,
  },
  'GroupAccountingController.prepare': {
    action: 'shareout.prepare',
    entityType: 'GroupCycle',
    load: cycle,
  },
  'GroupAccountingController.cancelPrepare': {
    action: 'shareout.cancel',
    entityType: 'GroupCycle',
    load: cycle,
  },
  'GroupAccountingController.approve': {
    action: 'shareout.approve',
    entityType: 'GroupCycle',
    load: cycle,
  },
  'GroupAccountingController.payAll': {
    action: 'shareout.pay_all',
    entityType: 'GroupCycle',
    load: cycle,
  },
  'GroupAccountingController.payShareOut': {
    action: 'shareout.pay',
    entityType: 'ShareOut',
    load: shareOut,
  },
  'GroupAccountingController.carryOver': {
    action: 'shareout.carry_over',
    entityType: 'ShareOut',
    load: shareOut,
  },
  'GroupAccountingController.createExpense': {
    action: 'expense.create',
    entityType: 'Expense',
  },
  'GroupAccountingController.approveExpense': {
    action: 'expense.approve',
    entityType: 'Expense',
    load: expense,
  },
  'GroupAccountingController.rejectExpense': {
    action: 'expense.reject',
    entityType: 'Expense',
    load: expense,
  },
  'GroupAccountingController.cancelExpense': {
    action: 'expense.cancel',
    entityType: 'Expense',
    load: expense,
  },
  'GroupAccountingController.requestSocial': {
    action: 'social_payout.request',
    entityType: 'SocialPayout',
  },
  'GroupAccountingController.approveSocial': {
    action: 'social_payout.approve',
    entityType: 'SocialPayout',
    load: socialPayout,
  },
  'GroupAccountingController.rejectSocial': {
    action: 'social_payout.reject',
    entityType: 'SocialPayout',
    load: socialPayout,
  },
  'GroupAccountingController.cancelSocial': {
    action: 'social_payout.cancel',
    entityType: 'SocialPayout',
    load: socialPayout,
  },
  'GroupAccountingController.paySocial': {
    action: 'social_payout.pay',
    entityType: 'SocialPayout',
    load: socialPayout,
  },
  'GroupAccountingController.rotationPay': {
    action: 'rotation.pay',
    entityType: 'RotationSlot',
  },
  'GroupAccountingController.rotationSkip': {
    action: 'rotation.skip',
    entityType: 'RotationSlot',
  },

  // account & security (msfts §8)
  'AuthController.verifyPhone': {
    action: 'auth.phone_login',
    entityType: 'User',
  },
  'AuthController.requestPhoneCode': {
    action: 'auth.phone_code_requested',
    entityType: 'User',
  },
  'AuthController.verifyTwoFactor': {
    action: 'auth.two_factor_login',
    entityType: 'User',
  },
  'AuthController.resendTwoFactor': {
    action: 'auth.two_factor_resend',
    entityType: 'User',
  },
  'AuthController.refresh': { action: 'auth.refresh', entityType: 'User' },
  'AuthController.logout': { action: 'auth.logout', entityType: 'User' },
  'AuthController.logoutAll': { action: 'auth.logout_all', entityType: 'User' },
  'AccountController.update': {
    action: 'account.profile.update',
    entityType: 'User',
  },
  'AccountController.changePassword': {
    action: 'account.password.change',
    entityType: 'User',
  },
  'AccountController.sendPhoneCode': {
    action: 'account.phone.code_sent',
    entityType: 'User',
  },
  'AccountController.verifyPhone': {
    action: 'account.phone.verified',
    entityType: 'User',
  },
  'AccountController.totpSetup': {
    action: 'account.2fa.totp_setup',
    entityType: 'User',
  },
  'AccountController.totpEnable': {
    action: 'account.2fa.enabled',
    entityType: 'User',
  },
  'AccountController.smsStart': {
    action: 'account.2fa.sms_setup',
    entityType: 'User',
  },
  'AccountController.smsConfirm': {
    action: 'account.2fa.enabled',
    entityType: 'User',
  },
  'AccountController.disable': {
    action: 'account.2fa.disabled',
    entityType: 'User',
  },
  'AccountController.recoveryCodes': {
    action: 'account.2fa.recovery_codes',
    entityType: 'User',
  },
  'AccountController.revokeSession': {
    action: 'account.session.revoke',
    entityType: 'RefreshToken',
  },
  'AccountController.requestDeletion': {
    action: 'account.deletion.request',
    entityType: 'AccountDeletionRequest',
  },
  'AccountController.cancelDeletion': {
    action: 'account.deletion.cancel',
    entityType: 'AccountDeletionRequest',
  },
  'AdminDeletionController.approve': {
    action: 'admin.deletion.approve',
    entityType: 'AccountDeletionRequest',
  },
  'AdminJobsController.retry': { action: 'admin.job.retry', entityType: 'Job' },
  'AdminDeletionController.reject': {
    action: 'admin.deletion.reject',
    entityType: 'AccountDeletionRequest',
  },

  // communication (msfts §7)
  'AnnouncementsController.create': {
    action: 'announcement.create',
    entityType: 'GroupAnnouncement',
  },
  'AnnouncementsController.pin': {
    action: 'announcement.pin',
    entityType: 'GroupAnnouncement',
  },
  'AnnouncementsController.remove': {
    action: 'announcement.delete',
    entityType: 'GroupAnnouncement',
  },
  'NotificationSettingsController.update': {
    action: 'notification.preferences.update',
    entityType: 'User',
  },
  'NotificationSettingsController.reset': {
    action: 'notification.preferences.reset',
    entityType: 'User',
  },
  'NotificationSettingsController.subscribe': {
    action: 'notification.push.subscribe',
    entityType: 'PushSubscription',
  },
  'NotificationSettingsController.unsubscribe': {
    action: 'notification.push.unsubscribe',
    entityType: 'PushSubscription',
  },
  'NotificationSettingsController.test': {
    action: 'notification.push.test',
    entityType: 'PushSubscription',
  },

  // payments callbacks (system)
  'MomoCallbackController.collectionPut': {
    action: 'momo.callback.collection',
  },
  'MomoCallbackController.collectionPost': {
    action: 'momo.callback.collection',
  },
  'MomoCallbackController.disbursementPut': {
    action: 'momo.callback.disbursement',
  },
  'MomoCallbackController.disbursementPost': {
    action: 'momo.callback.disbursement',
  },

  // platform administration
  'AdminUsersController.suspend': {
    action: 'admin.user.suspend',
    entityType: 'User',
    load: userSecurity,
  },
  'AdminUsersController.reactivate': {
    action: 'admin.user.reactivate',
    entityType: 'User',
    load: userSecurity,
  },
  'AdminUsersController.unlock': {
    action: 'admin.user.unlock',
    entityType: 'User',
    load: userSecurity,
  },
  'AdminUsersController.resetAccess': {
    action: 'admin.user.reset_access',
    entityType: 'User',
    load: userSecurity,
  },
  'AdminUsersController.resendVerification': {
    action: 'admin.user.resend_verification',
    entityType: 'User',
    load: userSecurity,
  },
  'AdminUsersController.verifyEmail': {
    action: 'admin.user.verify_email',
    entityType: 'User',
    load: userSecurity,
  },
  'AdminUsersController.impersonate': {
    action: 'admin.user.impersonate',
    entityType: 'User',
  },
  'PlatformSettingsController.update': {
    action: 'admin.platform_settings.update',
    entityType: 'PlatformSettings',
    load: (prisma) =>
      prisma.platformSettings.findUnique({ where: { id: 'platform' } }),
  },
  'AdminGroupsController.upsertPaymentAccount': {
    action: 'admin.group.payment_account.update',
    entityType: 'GroupPaymentAccount',
    load: paymentAccount,
  },
  'AdminGroupsController.removePaymentAccount': {
    action: 'admin.group.payment_account.remove',
    entityType: 'GroupPaymentAccount',
    load: paymentAccount,
  },
};

/** Routes never logged (pure UI state). */
export const AUDIT_SKIP = new Set([
  'UserNotificationsController.markAllRead',
  'UserNotificationsController.markRead',
  'GroupsController.markRemovalNotificationRead',
  // Every active tab refreshes every ~15 min; reuse detection is audited separately.
  'AuthController.refresh',
]);
