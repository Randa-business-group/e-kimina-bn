import { NotificationChannel, NotificationType as T } from '@prisma/client';

/** Preference categories shown to users (msfts §7). */
export const CATEGORIES = [
  {
    key: 'PAYMENTS',
    label: 'Payments',
    description: 'Deposits received, confirmed, rejected or failed.',
  },
  {
    key: 'REMINDERS',
    label: 'Reminders',
    description: 'Contributions and loan installments due soon or late.',
  },
  {
    key: 'LOANS',
    label: 'Loans',
    description: 'Applications, approvals, payouts, guarantees and penalties.',
  },
  { key: 'FINES', label: 'Fines', description: 'Fines issued or waived.' },
  {
    key: 'GROUP',
    label: 'Group membership',
    description: 'Joining, leaving, roles, verification and removals.',
  },
  {
    key: 'MEETINGS',
    label: 'Meetings & votes',
    description: 'Meetings, minutes, constitution and polls.',
  },
  {
    key: 'ACCOUNTING',
    label: 'Group money',
    description: 'Expenses, social fund, share-out and rotation payouts.',
  },
  {
    key: 'ANNOUNCEMENTS',
    label: 'Announcements',
    description: 'Messages your group admin sends to everyone.',
  },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]['key'];

const BY_CATEGORY: Record<CategoryKey, T[]> = {
  PAYMENTS: [
    T.DEPOSIT_MANUAL_PENDING,
    T.DEPOSIT_RECORDED,
    T.LOAN_REPAYMENT_RECORDED,
    T.DEPOSIT_CONFIRMED,
    T.LOAN_REPAYMENT_APPLIED,
    T.DEPOSIT_REJECTED,
    T.MANUAL_DEPOSIT_AUDIT_CONFIRM,
    T.MANUAL_DEPOSIT_AUDIT_REJECT,
    T.PAYMENT_PROOF_SUBMITTED,
    T.DEPOSIT_FAILED,
  ],
  REMINDERS: [
    T.CONTRIBUTION_DUE_SOON,
    T.CONTRIBUTION_LATE,
    T.LOAN_INSTALLMENT_DUE,
    T.LOAN_INSTALLMENT_LATE,
  ],
  LOANS: [
    T.LOAN_APPLICATION_SUBMITTED,
    T.LOAN_AWAITING_YOUR_APPROVAL,
    T.LOAN_DISBURSED,
    T.LOAN_REJECTED,
    T.LOAN_PENALTY_APPLIED,
    T.LOAN_DEFAULTED,
    T.LOAN_WRITTEN_OFF,
    T.LOAN_EXTENDED,
    T.LOAN_DISBURSEMENT_FAILED,
    T.GUARANTOR_REQUESTED,
    T.GUARANTOR_RESPONDED,
    T.GUARANTEE_CALLED,
    T.LOAN_APPLICATION_CANCELLED,
  ],
  FINES: [T.FINE_ISSUED, T.FINE_WAIVED],
  GROUP: [
    T.ADDED_TO_GROUP,
    T.NEW_GROUP_MEMBER,
    T.GROUP_INVITATION_PENDING,
    T.GROUP_VERIFICATION_REQUESTED,
    T.GROUP_VERIFIED,
    T.GROUP_VERIFICATION_REJECTED,
    T.ROLE_CHANGED,
    T.JOIN_REQUESTED,
    T.JOIN_APPROVED,
    T.JOIN_REJECTED,
    T.EXIT_REQUESTED,
    T.EXIT_SETTLED,
    T.EXIT_REJECTED,
    T.REMOVED_FROM_GROUP,
    T.SUSPENDED_IN_GROUP,
    T.MEMBERSHIP_REACTIVATED,
  ],
  MEETINGS: [
    T.MEETING_SCHEDULED,
    T.MEETING_CANCELLED,
    T.MEETING_MINUTES_PUBLISHED,
    T.CONSTITUTION_PUBLISHED,
    T.POLL_OPENED,
    T.POLL_CLOSED,
  ],
  ACCOUNTING: [
    T.EXPENSE_SUBMITTED,
    T.EXPENSE_APPROVED,
    T.EXPENSE_REJECTED,
    T.SOCIAL_PAYOUT_REQUESTED,
    T.SOCIAL_PAYOUT_APPROVED,
    T.SOCIAL_PAYOUT_REJECTED,
    T.SOCIAL_PAYOUT_PAID,
    T.SHARE_OUT_PREPARED,
    T.CYCLE_CLOSED,
    T.SHARE_OUT_PAID,
    T.ROTATION_PAYOUT_PAID,
    T.ROTATION_SWAP_REQUESTED,
    T.ROTATION_SWAP_RESPONDED,
    T.LEDGER_ADJUSTMENT,
  ],
  ANNOUNCEMENTS: [T.GROUP_ANNOUNCEMENT],
};

const CATEGORY_OF = new Map<T, CategoryKey>(
  (Object.entries(BY_CATEGORY) as [CategoryKey, T[]][]).flatMap(([c, types]) =>
    types.map((t) => [t, c] as [T, CategoryKey]),
  ),
);

export function categoryOf(type: T): CategoryKey {
  return CATEGORY_OF.get(type) ?? 'GROUP';
}

/** Always shown in the app, whatever the preference. */
export const MANDATORY_IN_APP = new Set<T>([
  T.REMOVED_FROM_GROUP,
  T.SUSPENDED_IN_GROUP,
]);

/** These already have their own email elsewhere; the generic email would be a duplicate. */
export const DEDICATED_EMAIL = new Set<T>([
  T.DEPOSIT_MANUAL_PENDING,
  T.DEPOSIT_CONFIRMED,
  T.LOAN_REPAYMENT_APPLIED,
  T.DEPOSIT_REJECTED,
  T.MANUAL_DEPOSIT_AUDIT_CONFIRM,
  T.MANUAL_DEPOSIT_AUDIT_REJECT,
  T.GROUP_INVITATION_PENDING,
]);

const EMAIL_DEFAULT_OFF = new Set<T>([
  T.NEW_GROUP_MEMBER,
  T.PAYMENT_PROOF_SUBMITTED,
  T.LEDGER_ADJUSTMENT,
]);

/** SMS costs money: on by default only for what members must not miss. */
const SMS_DEFAULT_ON = new Set<T>([
  T.DEPOSIT_RECORDED,
  T.LOAN_REPAYMENT_RECORDED,
  T.DEPOSIT_CONFIRMED,
  T.LOAN_REPAYMENT_APPLIED,
  T.DEPOSIT_REJECTED,
  T.DEPOSIT_FAILED,
  T.CONTRIBUTION_DUE_SOON,
  T.CONTRIBUTION_LATE,
  T.LOAN_INSTALLMENT_DUE,
  T.LOAN_INSTALLMENT_LATE,
  T.LOAN_AWAITING_YOUR_APPROVAL,
  T.LOAN_DISBURSED,
  T.LOAN_REJECTED,
  T.LOAN_DEFAULTED,
  T.GUARANTOR_REQUESTED,
  T.GUARANTEE_CALLED,
  T.FINE_ISSUED,
  T.REMOVED_FROM_GROUP,
  T.SUSPENDED_IN_GROUP,
  T.MEETING_SCHEDULED,
  T.MEETING_CANCELLED,
  T.SOCIAL_PAYOUT_PAID,
  T.SHARE_OUT_PAID,
  T.GROUP_ANNOUNCEMENT,
]);

/** Default when the user has no preference row for (channel, category). */
export function defaultEnabled(channel: NotificationChannel, type: T): boolean {
  switch (channel) {
    case NotificationChannel.IN_APP:
    case NotificationChannel.PUSH:
      return true;
    case NotificationChannel.EMAIL:
      return !EMAIL_DEFAULT_OFF.has(type);
    case NotificationChannel.SMS:
      return SMS_DEFAULT_ON.has(type);
  }
}

/** Category default for the settings screen (on when most of its types default on). */
export function categoryDefault(
  channel: NotificationChannel,
  category: CategoryKey,
): boolean {
  const types = BY_CATEGORY[category];
  const on = types.filter((t) => defaultEnabled(channel, t)).length;
  return on * 2 >= types.length;
}

export function typesOf(category: CategoryKey): T[] {
  return BY_CATEGORY[category];
}
