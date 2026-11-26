/**
 * Detailed demo seed — one fully populated savings group.
 *
 *   Group:   "Twisungane Savings Group" (verified, private, weekly 5,000 RWF every Friday)
 *   People:  1 GROUP_ADMIN + 1 TREASURER + 20 MEMBERs, all on @yopmail.com
 *   History: every Friday from 2 Jan 2026 up to "today" (+ the next upcoming Friday)
 *
 * What gets generated (mirrors the real service logic in src/group-finance/*):
 *   - Contribution rows per member per week (PAID / LATE / PENDING)
 *   - DepositRecords: MTN MoMo (auto-confirmed), manual transfers (confirmed by
 *     admin/treasurer), a few REJECTED proofs + resubmission, and a few still
 *     PENDING_VERIFICATION so the review queue is not empty
 *   - Late fines (latePenaltyRate % on rows paid after the grace period)
 *   - Loan applications in every state: APPROVED→REPAID, APPROVED→ACTIVE,
 *     ACTIVE overdue with penalty, DEFAULTED, REJECTED, and PENDING
 *     (no approvals / admin-only / treasurer-only)
 *   - Loan repayments (MoMo, manual confirmed, manual pending)
 *   - Fine rows (paid late fines + open fines on LATE rows), DepositAllocation rows for every
 *     confirmed deposit, LoanDisbursement rows; loan due dates count from disbursement
 *   - In-app UserNotifications matching what the services would have produced
 *
 * Re-running is safe: the group (and everything cascading from it) is deleted
 * and rebuilt; users are upserted by email. Data is deterministic (fixed PRNG
 * seed) except that "today" moves forward.
 *
 * Usage (from prisma/seed.ts):
 *   await seedDetailedGroup(prisma, { passwordHash });
 *   await removeDetailedGroup(prisma, { deleteUsers: true }); // wipe it again
 */
import { randomUUID } from 'node:crypto';
import {
  AllocationKind,
  ContributionInterval,
  ContributionStatus,
  DepositPaymentMethod,
  DepositPurpose,
  DepositRecordStatus,
  FineStatus,
  FineType,
  GroupVerificationStatus,
  LoanDisbursementMethod,
  LoanDisbursementStatus,
  GroupMembershipStatus,
  LoanApplicationStatus,
  MemberLoanStatus,
  NotificationAudience,
  NotificationType,
  Prisma,
  PrismaClient,
  RoleName,
} from '@prisma/client';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const DETAILED_GROUP_NAME = 'Twisungane Savings Group';
const EMAIL_DOMAIN = 'yopmail.com';
const CURRENCY = 'RWF';
const RNG_SEED = 20260101;

/** First Friday of 2026 — the first contribution due date. */
const FIRST_DUE_YMD = '2026-01-02';
const DUE_HOUR_UTC = 8; // 10:00 Kigali time

const CONTRIBUTION = {
  amount: 5_000,
  interval: ContributionInterval.WEEKLY,
  dayOfWeek: 5, // Friday
  allowPartialPayments: false,
  latePenaltyRate: 10, // % of the missed contribution
  gracePeriodDays: 2,
};

const LOAN = {
  interestRate: 5, // flat % on principal
  repaymentPeriodDays: 90,
  allowExceedContribution: true,
  maxLoanMultiplier: 3,
  allowPartialPayments: true,
  penaltyRate: 2, // % of outstanding per 30 days overdue (after grace)
  gracePeriodDays: 7,
  penaltyPeriodDays: 30,
  defaultAfterDays: 120, // DEFAULTED 120 days after due date + grace
  blockIfArrears: true,
};

/** Public Cloudinary demo image, used as the "receipt" for manual transfers. */
const PROOF_IMAGE_URL = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';

/** Notifications older than this many days are marked as read. */
const READ_AFTER_DAYS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// People
// ─────────────────────────────────────────────────────────────────────────────

type ProfileName = 'exemplary' | 'regular' | 'irregular';

/** Per-week probabilities; whatever remains is "skips this week, pays later". */
const PROFILES: Record<ProfileName, { onTime: number; late: number; momo: number }> = {
  exemplary: { onTime: 0.97, late: 0.03, momo: 0.85 },
  regular: { onTime: 0.85, late: 0.1, momo: 0.7 },
  irregular: { onTime: 0.62, late: 0.18, momo: 0.6 },
};

interface PersonSpec {
  key: string;
  fullName: string;
  emailLocal: string;
  phone: string;
  role: RoleName;
  profile: ProfileName;
  joinedOn: string;
  /** Stops paying for the last N weeks → ends with LATE rows and unpaid fines. */
  stopsPayingLastWeeks?: number;
  /** Latest payment is a manual transfer still awaiting review. */
  pendingManualLatest?: boolean;
  /** Week index (0-based) where a manual proof is rejected, then resubmitted. */
  rejectedProofWeek?: number;
}

const LEADERS: PersonSpec[] = [
  {
    key: 'admin',
    fullName: 'Jean Bosco Habimana',
    emailLocal: 'twisungane.admin',
    phone: '+250788100001',
    role: RoleName.GROUP_ADMIN,
    profile: 'exemplary',
    joinedOn: '2025-12-01',
  },
  {
    key: 'treasurer',
    fullName: 'Claudine Mukamana',
    emailLocal: 'twisungane.treasurer',
    phone: '+250788100002',
    role: RoleName.TREASURER,
    profile: 'exemplary',
    joinedOn: '2025-12-01',
  },
];

const MEMBER_NAMES = [
  'Eric Niyonzima',
  'Aline Uwase',
  'Patrick Mugisha',
  'Diane Ingabire',
  'Emmanuel Nshimiyimana',
  'Josiane Uwimana',
  'Olivier Hakizimana',
  'Grace Mukeshimana',
  'Innocent Ndayisaba',
  'Sandrine Umutoni',
  'Fabrice Iradukunda',
  'Chantal Nyirahabimana',
  'Theogene Bizimana',
  'Vestine Mukandayisenga',
  'Alexis Tuyishime',
  'Solange Uwamahoro',
  'Jean Claude Munyaneza',
  'Esperance Nyiraneza',
  'Didier Kwizera',
  "Jeanne d'Arc Uwera",
];

const MEMBER_TRAITS: Record<number, Partial<PersonSpec>> = {
  1: { profile: 'exemplary' },
  2: { profile: 'exemplary' },
  3: { profile: 'exemplary' },
  4: { profile: 'exemplary' },
  5: { profile: 'exemplary' },
  6: { profile: 'regular' },
  7: { profile: 'regular', rejectedProofWeek: 8 },
  8: { profile: 'regular' },
  9: { profile: 'exemplary' },
  10: { profile: 'exemplary' },
  11: { profile: 'irregular' },
  12: { profile: 'exemplary' },
  13: { profile: 'exemplary' },
  14: { profile: 'regular', pendingManualLatest: true },
  15: { profile: 'regular', rejectedProofWeek: 20 },
  16: { profile: 'regular' },
  17: { profile: 'irregular', stopsPayingLastWeeks: 3 },
  18: { profile: 'irregular', stopsPayingLastWeeks: 5 },
  19: { profile: 'irregular', stopsPayingLastWeeks: 2 },
  20: { profile: 'regular', pendingManualLatest: true, rejectedProofWeek: 33 },
};

const MEMBERS: PersonSpec[] = MEMBER_NAMES.map((fullName, i) => {
  const n = i + 1;
  const nn = String(n).padStart(2, '0');
  return {
    key: `m${nn}`,
    fullName,
    emailLocal: `twisungane.member${nn}`,
    phone: `+25078${String(8200000 + n * 137).padStart(7, '0')}`,
    role: RoleName.MEMBER,
    profile: 'regular',
    joinedOn: `2025-12-${String(2 + n).padStart(2, '0')}`,
    ...MEMBER_TRAITS[n],
  };
});

export const DETAILED_PEOPLE: PersonSpec[] = [...LEADERS, ...MEMBERS];

export const detailedEmail = (p: Pick<PersonSpec, 'emailLocal'>) =>
  `${p.emailLocal}@${EMAIL_DOMAIN}`;

// ─────────────────────────────────────────────────────────────────────────────
// Loans — a scripted story so every state appears exactly where it makes sense
// ─────────────────────────────────────────────────────────────────────────────

type RepaymentMethod = 'MOMO' | 'MANUAL' | 'MANUAL_PENDING';

interface RepaymentSpec {
  /** Days after the application date. */
  afterDays: number;
  amount?: number;
  /** Share of totalRepayable, rounded to 100 RWF. */
  portion?: number;
  /** Pays whatever is left. */
  rest?: true;
  method?: RepaymentMethod;
}

type LoanOutcome =
  | 'DISBURSED' // final status derived from repayments: REPAID or ACTIVE
  | 'DEFAULTED'
  | 'REJECTED'
  | 'PENDING_NONE'
  | 'PENDING_ADMIN_OK'
  | 'PENDING_TREASURER_OK';

interface LoanPlan {
  who: string;
  appliedOn: string;
  amount: number;
  outcome: LoanOutcome;
  repayments?: RepaymentSpec[];
  rejection?: { by: 'admin' | 'treasurer'; reason: string };
  /** Which approver signs first (default alternates). */
  firstApprover?: 'admin' | 'treasurer';
}

const thirds = (method2: RepaymentMethod = 'MOMO'): RepaymentSpec[] => [
  { afterDays: 30, portion: 1 / 3 },
  { afterDays: 59, portion: 1 / 3, method: method2 },
  { afterDays: 87, rest: true },
];

const LOAN_PLANS: LoanPlan[] = [
  { who: 'm01', appliedOn: '2026-02-16', amount: 60_000, outcome: 'DISBURSED', repayments: thirds() },
  { who: 'm02', appliedOn: '2026-03-09', amount: 80_000, outcome: 'DISBURSED', repayments: thirds('MANUAL') },
  {
    who: 'm18',
    appliedOn: '2026-03-23',
    amount: 50_000,
    outcome: 'DEFAULTED',
    repayments: [{ afterDays: 33, amount: 20_000 }],
  },
  { who: 'm05', appliedOn: '2026-04-13', amount: 120_000, outcome: 'DISBURSED', repayments: thirds() },
  { who: 'treasurer', appliedOn: '2026-05-04', amount: 150_000, outcome: 'DISBURSED', repayments: thirds() },
  {
    // Overdue: due ~30 Aug, only partly repaid → penaltyAccrued > 0
    who: 'm08',
    appliedOn: '2026-06-01',
    amount: 100_000,
    outcome: 'DISBURSED',
    repayments: [
      { afterDays: 31, amount: 30_000 },
      { afterDays: 62, amount: 20_000, method: 'MANUAL' },
    ],
  },
  { who: 'admin', appliedOn: '2026-07-20', amount: 100_000, outcome: 'DISBURSED', repayments: thirds() },
  {
    who: 'm11',
    appliedOn: '2026-08-10',
    amount: 150_000,
    outcome: 'REJECTED',
    rejection: {
      by: 'treasurer',
      reason:
        'Several late contributions in the last two months. Please clear arrears and re-apply next cycle.',
    },
  },
  { who: 'm10', appliedOn: '2026-08-17', amount: 200_000, outcome: 'DISBURSED', repayments: thirds() },
  {
    // Second loan for m01 — active, last installment submitted manually and awaiting review
    who: 'm01',
    appliedOn: '2026-09-07',
    amount: 100_000,
    outcome: 'DISBURSED',
    repayments: [
      { afterDays: 30, amount: 35_000 },
      { afterDays: 60, amount: 35_000 },
      { afterDays: 79, rest: true, method: 'MANUAL_PENDING' },
    ],
  },
  {
    who: 'm03',
    appliedOn: '2026-10-05',
    amount: 70_000,
    outcome: 'DISBURSED',
    repayments: [{ afterDays: 30, portion: 1 / 3 }],
  },
  { who: 'm06', appliedOn: '2026-11-23', amount: 120_000, outcome: 'PENDING_ADMIN_OK' },
  { who: 'm04', appliedOn: '2026-11-24', amount: 90_000, outcome: 'PENDING_NONE' },
  { who: 'm07', appliedOn: '2026-11-25', amount: 60_000, outcome: 'PENDING_TREASURER_OK' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * HOUR);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const atUtc = (ymd: string, hour = DUE_HOUR_UTC) =>
  new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00.000Z`);
const maxDate = (a: Date, b: Date) => (a > b ? a : b);
const round2 = (n: number) => Math.round(n * 100) / 100;
const round100 = (n: number) => Math.round(n / 100) * 100;
const money = (n: number) => round2(n).toFixed(2);
const fmt2 = (n: number) => round2(n).toFixed(2);
const fmt0 = (n: number) => Math.round(n).toFixed(0);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure planner — builds every row in memory (no DB access)
// ─────────────────────────────────────────────────────────────────────────────

export interface DetailedGroupPlan {
  contributions: Prisma.ContributionCreateManyInput[];
  deposits: Prisma.DepositRecordCreateManyInput[];
  applications: Prisma.LoanApplicationCreateManyInput[];
  loans: Prisma.MemberLoanCreateManyInput[];
  disbursements: Prisma.LoanDisbursementCreateManyInput[];
  fines: Prisma.FineCreateManyInput[];
  allocations: Prisma.DepositAllocationCreateManyInput[];
  notifications: Prisma.UserNotificationCreateManyInput[];
  warnings: string[];
}

interface ContributionDraft {
  id: string;
  dueDate: Date;
  status: ContributionStatus;
  paidAt: Date | null;
}

export function planDetailedGroup(input: {
  today: Date;
  groupId: string;
  userIds: Record<string, string>;
}): DetailedGroupPlan {
  const { today, groupId, userIds } = input;
  const rng = mulberry32(RNG_SEED);
  const randInt = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

  const people = new Map(DETAILED_PEOPLE.map((p) => [p.key, p]));
  const uid = (key: string) => {
    const id = userIds[key];
    if (!id) throw new Error(`newseed: no user id for "${key}"`);
    return id;
  };
  const adminId = uid('admin');
  const treasurerId = uid('treasurer');
  const otherLeaderKey = (key: string) => (key === 'admin' ? 'treasurer' : 'admin');

  const contributions: Prisma.ContributionCreateManyInput[] = [];
  const deposits: Prisma.DepositRecordCreateManyInput[] = [];
  const applications: Prisma.LoanApplicationCreateManyInput[] = [];
  const loans: Prisma.MemberLoanCreateManyInput[] = [];
  const disbursements: Prisma.LoanDisbursementCreateManyInput[] = [];
  const fines: Prisma.FineCreateManyInput[] = [];
  const allocations: Prisma.DepositAllocationCreateManyInput[] = [];
  const notifications: Prisma.UserNotificationCreateManyInput[] = [];
  const warnings: string[] = [];

  const readCutoff = addDays(today, -READ_AFTER_DAYS);

  // ── notification helpers ────────────────────────────────────────────────
  const note = (
    userId: string,
    audience: NotificationAudience,
    type: NotificationType,
    title: string,
    body: string,
    at: Date,
    metadata?: Record<string, unknown>,
  ) => {
    notifications.push({
      id: randomUUID(),
      userId,
      groupId,
      type,
      audience,
      title,
      body,
      createdAt: at,
      readAt: at < readCutoff ? addHours(at, randInt(1, 30)) : null,
      ...(metadata ? { metadata: metadata as Prisma.InputJsonValue } : {}),
    });
  };
  const noteLeaders = (
    excludeUserId: string | null,
    type: NotificationType,
    title: string,
    body: string,
    at: Date,
    metadata?: Record<string, unknown>,
  ) => {
    if (adminId !== excludeUserId) note(adminId, NotificationAudience.GROUP_ADMIN, type, title, body, at, metadata);
    if (treasurerId !== excludeUserId)
      note(treasurerId, NotificationAudience.TREASURER, type, title, body, at, metadata);
  };
  const g = DETAILED_GROUP_NAME;

  // ── membership notifications ────────────────────────────────────────────
  for (const p of DETAILED_PEOPLE) {
    const at = atUtc(p.joinedOn, 9);
    if (p.role === RoleName.GROUP_ADMIN) continue; // admin created the group
    const userId = uid(p.key);
    note(
      userId,
      NotificationAudience.MEMBER,
      NotificationType.ADDED_TO_GROUP,
      'You were added to a group',
      `You were added to “${g}”. You can now participate in the group.`,
      at,
      { groupName: g, context: 'invited' },
    );
    noteLeaders(
      userId,
      NotificationType.NEW_GROUP_MEMBER,
      'New member in your group',
      `${p.fullName} was added to the group by an admin in “${g}”.`,
      addHours(at, 0.1),
      { groupName: g, memberUserId: userId, how: 'invited' },
    );
  }

  // ── contribution schedule ───────────────────────────────────────────────
  const firstDue = atUtc(FIRST_DUE_YMD);
  const dueDates: Date[] = [];
  for (let d = firstDue; d <= today; d = addDays(d, 7)) dueDates.push(d);
  const nextDue = dueDates.length ? addDays(dueDates[dueDates.length - 1], 7) : firstDue;

  const graceEnd = (due: Date) => addDays(due, CONTRIBUTION.gracePeriodDays);
  const isLateAt = (due: Date, t: Date) => t > graceEnd(due);
  const fineFor = (due: Date, t: Date) =>
    isLateAt(due, t) ? CONTRIBUTION.amount * (CONTRIBUTION.latePenaltyRate / 100) : 0;

  const paidRowsByUser = new Map<string, ContributionDraft[]>();

  for (const person of DETAILED_PEOPLE) {
    const userId = uid(person.key);
    const profile = PROFILES[person.profile];
    const reviewerFor = () =>
      person.key === 'admin' ? 'treasurer' : person.key === 'treasurer' ? 'admin' : rng() < 0.6 ? 'treasurer' : 'admin';

    const rows: ContributionDraft[] = [];
    let open: ContributionDraft[] = [];

    const portions = (covered: ContributionDraft[], t: Date) => {
      const contribution = covered.length * CONTRIBUTION.amount;
      const fine = covered.reduce((s, r) => s + fineFor(r.dueDate, t), 0);
      return { contribution, fine, total: contribution + fine };
    };

    const baseDeposit = (amounts: { contribution: number; fine: number; total: number }) => ({
      userId,
      groupId,
      amount: money(amounts.total),
      currency: CURRENCY,
      contributionPortion: money(amounts.contribution),
      finePortion: money(amounts.fine),
      installmentPortion: money(0),
    });

    const markPaid = (covered: ContributionDraft[], at: Date, depositId: string, pricedAt: Date) => {
      for (const r of covered) {
        r.status = ContributionStatus.PAID;
        r.paidAt = at;
        const fine = fineFor(r.dueDate, pricedAt);
        if (fine > 0) {
          const fineId = randomUUID();
          fines.push({
            id: fineId,
            groupId,
            userId,
            type: FineType.LATE_CONTRIBUTION,
            amount: money(fine),
            amountPaid: money(fine),
            currency: CURRENCY,
            reason: `Late contribution due ${r.dueDate.toISOString().slice(0, 10)} (${CONTRIBUTION.latePenaltyRate}% fine)`,
            status: FineStatus.PAID,
            contributionId: r.id,
            paidAt: at,
            createdAt: addHours(graceEnd(r.dueDate), 1),
          });
          allocations.push({ depositId, kind: AllocationKind.FINE, amount: money(fine), fineId, createdAt: at });
        }
        allocations.push({
          depositId,
          kind: AllocationKind.CONTRIBUTION,
          amount: money(CONTRIBUTION.amount),
          contributionId: r.id,
          createdAt: at,
        });
      }
    };

    const payMomo = (t: Date) => {
      const covered = open;
      const amounts = portions(covered, t);
      const depositId = randomUUID();
      deposits.push({
        ...baseDeposit(amounts),
        id: depositId,
        paymentMethod: DepositPaymentMethod.MTN_MOMO,
        phone: person.phone,
        status: DepositRecordStatus.CONFIRMED,
        reviewedAt: t,
        createdAt: t,
        externalReference: randomUUID(),
        providerStatus: 'SUCCESSFUL',
        providerTransactionId: `SEED-${depositId.slice(0, 8)}`,
      });
      markPaid(covered, t, depositId, t);
      open = [];
      note(
        userId,
        NotificationAudience.MEMBER,
        NotificationType.DEPOSIT_RECORDED,
        'Payment recorded',
        `Your ${fmt2(amounts.total)} ${CURRENCY} payment was applied in ${g}.`,
        addHours(t, 0.02),
        { groupName: g, amount: fmt2(amounts.total), currency: CURRENCY },
      );
    };

    const payManual = (t: Date, opts: { reject?: boolean; forcePending?: boolean } = {}) => {
      let submitAt = t;

      if (opts.reject) {
        const amounts = portions(open, submitAt);
        const reviewerKey = reviewerFor();
        const rejectedAt = addHours(submitAt, randInt(2, 8));
        const depositId = randomUUID();
        const reason = 'The receipt image is blurry and the transaction reference cannot be read. Please upload a clearer screenshot.';
        deposits.push({
          ...baseDeposit(amounts),
          id: depositId,
          paymentMethod: DepositPaymentMethod.MANUAL_TRANSFER,
          status: DepositRecordStatus.REJECTED,
          proofImageUrl: PROOF_IMAGE_URL,
          rejectionReason: reason,
          reviewedAt: rejectedAt,
          reviewedByUserId: uid(reviewerKey),
          createdAt: submitAt,
        });
        manualSubmittedNotes(amounts.total, submitAt, depositId, false);
        note(
          userId,
          NotificationAudience.MEMBER,
          NotificationType.DEPOSIT_REJECTED,
          'Payment not accepted',
          `Your ${fmt2(amounts.total)} ${CURRENCY} transfer in ${g} was not accepted. ${reason}`,
          rejectedAt,
          { groupName: g, reason },
        );
        auditNote(reviewerKey, false, amounts.total, rejectedAt);
        submitAt = addHours(rejectedAt, randInt(3, 20));
      }

      if (submitAt > today) return; // resubmission would be in the future → stays open

      const amounts = portions(open, submitAt);
      const depositId = randomUUID();
      const reviewerKey = reviewerFor();
      const reviewAt = addHours(submitAt, randInt(2, 30));
      manualSubmittedNotes(amounts.total, submitAt, depositId, false);

      if (opts.forcePending || reviewAt > today) {
        deposits.push({
          ...baseDeposit(amounts),
          id: depositId,
          paymentMethod: DepositPaymentMethod.MANUAL_TRANSFER,
          status: DepositRecordStatus.PENDING_VERIFICATION,
          proofImageUrl: PROOF_IMAGE_URL,
          createdAt: submitAt,
        });
        open = []; // rows stay unpaid (status by date) until a leader reviews
        return;
      }

      deposits.push({
        ...baseDeposit(amounts),
        id: depositId,
        paymentMethod: DepositPaymentMethod.MANUAL_TRANSFER,
        status: DepositRecordStatus.CONFIRMED,
        proofImageUrl: PROOF_IMAGE_URL,
        reviewedAt: reviewAt,
        reviewedByUserId: uid(reviewerKey),
        createdAt: submitAt,
      });
      markPaid(open, reviewAt, depositId, submitAt); // service sets paidAt when the leader confirms
      open = [];
      note(
        userId,
        NotificationAudience.MEMBER,
        NotificationType.DEPOSIT_CONFIRMED,
        'Payment confirmed',
        `Your payment of ${fmt2(amounts.total)} ${CURRENCY} was confirmed in ${g}.`,
        reviewAt,
        { groupName: g, amount: fmt2(amounts.total), currency: CURRENCY },
      );
      auditNote(reviewerKey, true, amounts.total, reviewAt);
    };

    function manualSubmittedNotes(total: number, at: Date, depositId: string, isLoan: boolean) {
      note(
        userId,
        NotificationAudience.MEMBER,
        NotificationType.PAYMENT_PROOF_SUBMITTED,
        isLoan ? 'Loan repayment received' : 'Payment proof received',
        isLoan
          ? `We received your ${fmt2(total)} ${CURRENCY} loan repayment proof in ${g}. A group admin or treasurer will review it.`
          : `We received your ${fmt2(total)} ${CURRENCY} transfer proof in ${g}. A group admin or treasurer will review it.`,
        addHours(at, 0.02),
        { groupName: g },
      );
      noteLeaders(
        null,
        NotificationType.DEPOSIT_MANUAL_PENDING,
        isLoan ? 'Loan repayment proof to review' : 'Payment proof to review',
        isLoan
          ? `${person.fullName} submitted a loan repayment transfer (${fmt2(total)} ${CURRENCY}) in ${g}.`
          : `${person.fullName} submitted a bank transfer proof (${fmt2(total)} ${CURRENCY}) in ${g}.`,
        addHours(at, 0.03),
        { groupName: g, depositId, amount: fmt2(total), currency: CURRENCY },
      );
    }

    function auditNote(reviewerKey: string, confirmed: boolean, total: number, at: Date) {
      const otherKey = otherLeaderKey(reviewerKey);
      const otherId = uid(otherKey);
      note(
        otherId,
        otherKey === 'admin' ? NotificationAudience.GROUP_ADMIN : NotificationAudience.TREASURER,
        confirmed ? NotificationType.MANUAL_DEPOSIT_AUDIT_CONFIRM : NotificationType.MANUAL_DEPOSIT_AUDIT_REJECT,
        confirmed ? 'Manual payment confirmed' : 'Manual payment rejected',
        `A ${fmt2(total)} ${CURRENCY} transfer from ${person.fullName} was ${confirmed ? 'confirmed' : 'rejected'} in ${g}.`,
        addHours(at, 0.05),
        { groupName: g },
      );
    }

    // Walk the year week by week
    dueDates.forEach((due, i) => {
      const row: ContributionDraft = { id: randomUUID(), dueDate: due, status: ContributionStatus.PENDING, paidAt: null };
      rows.push(row);
      open.push(row);

      const isLatest = i === dueDates.length - 1;
      const stopped =
        person.stopsPayingLastWeeks != null && i >= dueDates.length - person.stopsPayingLastWeeks;
      if (stopped) return;

      if (isLatest && person.pendingManualLatest) {
        let t = addHours(today, -randInt(5, 30));
        if (t < due) t = addHours(due, 1);
        payManual(t, { forcePending: true });
        return;
      }

      const r = rng();
      let t: Date;
      if (r < profile.onTime) {
        t = addHours(due, -randInt(2, 60)); // up to 2.5 days early
      } else if (r < profile.onTime + profile.late) {
        t = addHours(addDays(due, randInt(3, 6)), randInt(0, 10)); // after grace → fine
      } else {
        return; // skipped — covered by the next payment (with fine)
      }
      if (t > today) return;

      if (person.rejectedProofWeek === i) {
        payManual(t, { reject: true });
      } else if (rng() < profile.momo) {
        payMomo(t);
      } else {
        payManual(t);
      }
    });

    // Rows still unpaid get their status from the calendar (the API has no job for this)
    for (const r of rows) {
      if (r.status !== ContributionStatus.PAID) {
        r.status = isLateAt(r.dueDate, today) ? ContributionStatus.LATE : ContributionStatus.PENDING;
        if (r.status === ContributionStatus.LATE) {
          // What the daily job does: freeze the late fine when the row turns LATE.
          fines.push({
            id: randomUUID(),
            groupId,
            userId,
            type: FineType.LATE_CONTRIBUTION,
            amount: money(CONTRIBUTION.amount * (CONTRIBUTION.latePenaltyRate / 100)),
            currency: CURRENCY,
            reason: `Late contribution due ${r.dueDate.toISOString().slice(0, 10)} (${CONTRIBUTION.latePenaltyRate}% fine)`,
            status: FineStatus.OPEN,
            contributionId: r.id,
            createdAt: addHours(graceEnd(r.dueDate), 1),
          });
        }
      }
    }
    // Next upcoming period
    rows.push({ id: randomUUID(), dueDate: nextDue, status: ContributionStatus.PENDING, paidAt: null });

    for (const r of rows) {
      contributions.push({
        id: r.id,
        userId,
        groupId,
        amount: money(CONTRIBUTION.amount),
        amountPaid: money(r.status === ContributionStatus.PAID ? CONTRIBUTION.amount : 0),
        dueDate: r.dueDate,
        paidAt: r.paidAt,
        status: r.status,
        lateMarkedAt: r.status === ContributionStatus.LATE ? addHours(graceEnd(r.dueDate), 1) : null,
        createdAt: addDays(r.dueDate, -7),
      });
    }
    paidRowsByUser.set(person.key, rows);
  }

  // ── loans ────────────────────────────────────────────────────────────────
  const openLoanUntil = new Map<string, Date>(); // who → date their current loan closed (or far future)

  LOAN_PLANS.forEach((plan, planIndex) => {
    const found = people.get(plan.who);
    if (!found) throw new Error(`newseed: unknown loan borrower "${plan.who}"`);
    const person: PersonSpec = found;
    const appliedAt = atUtc(plan.appliedOn, 9);
    if (appliedAt > today) return;

    const userId = uid(person.key);
    const isAdminApplicant = person.role === RoleName.GROUP_ADMIN;
    const isTreasurerApplicant = person.role === RoleName.TREASURER;

    const busyUntil = openLoanUntil.get(person.key);
    if (busyUntil && busyUntil > appliedAt) {
      warnings.push(`Loan for ${person.key} on ${plan.appliedOn} skipped: previous loan still open.`);
      return;
    }

    // Eligibility exactly like getLoanRequestPreview: paid contributions × multiplier
    const paidSoFar =
      (paidRowsByUser.get(person.key) ?? []).filter(
        (r) => r.status === ContributionStatus.PAID && r.paidAt != null && r.paidAt <= appliedAt,
      ).length * CONTRIBUTION.amount;
    const maxAmount = round2(paidSoFar * LOAN.maxLoanMultiplier);
    let principal = plan.amount;
    if (principal > maxAmount) {
      const clamped = Math.floor(maxAmount / 10_000) * 10_000;
      warnings.push(
        `Loan for ${person.key} on ${plan.appliedOn}: ${principal} > max ${maxAmount}; clamped to ${clamped}.`,
      );
      principal = clamped;
    }
    if (principal <= 0) return;

    const appId = randomUUID();
    const first = plan.firstApprover ?? (planIndex % 2 === 0 ? 'admin' : 'treasurer');
    const firstAt = addHours(appliedAt, 25);
    const secondAt = addHours(appliedAt, 29 + randInt(0, 20));

    let adminApprovedAt: Date | null = isAdminApplicant ? appliedAt : null;
    let treasurerApprovedAt: Date | null = isTreasurerApplicant ? appliedAt : null;
    let status: LoanApplicationStatus = LoanApplicationStatus.PENDING;
    let rejection: { at: Date; by: string; reason: string } | null = null;

    const amount0 = fmt0(principal);
    note(
      userId,
      NotificationAudience.MEMBER,
      NotificationType.LOAN_APPLICATION_SUBMITTED,
      'Loan request received',
      `We received your request for ${amount0} RWF in ${g}. A group admin and the treasurer must both approve before disbursement.`,
      addHours(appliedAt, 0.02),
      { applicationId: appId, groupName: g },
    );
    noteLeaders(
      userId,
      NotificationType.LOAN_APPLICATION_SUBMITTED,
      'New loan application',
      `${person.fullName} applied for a ${amount0} RWF loan in ${g}. Your approval may be required.`,
      addHours(appliedAt, 0.03),
      { applicationId: appId, groupName: g },
    );

    const awaiting = (justApproved: 'admin' | 'treasurer', at: Date) => {
      if (justApproved === 'admin') {
        note(
          treasurerId,
          NotificationAudience.TREASURER,
          NotificationType.LOAN_AWAITING_YOUR_APPROVAL,
          'Loan needs treasurer approval',
          `Group admin approved ${person.fullName}’s ${amount0} RWF loan in ${g}. Your approval is still required to disburse.`,
          at,
          { applicationId: appId, groupName: g },
        );
      } else {
        note(
          adminId,
          NotificationAudience.GROUP_ADMIN,
          NotificationType.LOAN_AWAITING_YOUR_APPROVAL,
          'Loan needs admin approval',
          `Treasurer approved ${person.fullName}’s ${amount0} RWF loan in ${g}. A group admin must still approve to disburse.`,
          at,
          { applicationId: appId, groupName: g },
        );
      }
    };

    switch (plan.outcome) {
      case 'PENDING_NONE':
        break;
      case 'PENDING_ADMIN_OK':
        adminApprovedAt = addHours(appliedAt, 5);
        awaiting('admin', adminApprovedAt);
        break;
      case 'PENDING_TREASURER_OK':
        treasurerApprovedAt = addHours(appliedAt, 3);
        awaiting('treasurer', treasurerApprovedAt);
        break;
      case 'REJECTED': {
        const by = plan.rejection?.by ?? 'treasurer';
        rejection = {
          at: addHours(appliedAt, 26),
          by,
          reason: plan.rejection?.reason ?? 'Not eligible at this time.',
        };
        status = LoanApplicationStatus.REJECTED;
        note(
          userId,
          NotificationAudience.MEMBER,
          NotificationType.LOAN_REJECTED,
          'Loan request declined',
          `Your loan request in ${g} was declined. ${rejection.reason}`,
          rejection.at,
          { groupName: g },
        );
        break;
      }
      case 'DISBURSED':
      case 'DEFAULTED': {
        // Fill whichever approval slots are still empty
        if (adminApprovedAt == null && treasurerApprovedAt == null) {
          if (first === 'admin') {
            adminApprovedAt = firstAt;
            treasurerApprovedAt = secondAt;
          } else {
            treasurerApprovedAt = firstAt;
            adminApprovedAt = secondAt;
          }
          awaiting(first, firstAt);
        } else if (adminApprovedAt == null) {
          adminApprovedAt = firstAt;
        } else if (treasurerApprovedAt == null) {
          treasurerApprovedAt = firstAt;
        }
        const disbursedAt = maxDate(adminApprovedAt!, treasurerApprovedAt!);
        if (disbursedAt > today) {
          warnings.push(`Loan for ${person.key} on ${plan.appliedOn} not yet disbursed as of today.`);
          break;
        }
        status = LoanApplicationStatus.APPROVED;
        buildLoan(disbursedAt);
        break;
      }
    }

    applications.push({
      id: appId,
      userId,
      groupId,
      requestedAmount: money(principal),
      status,
      interestRateSnapshot: money(LOAN.interestRate),
      repaymentPeriodDaysSnapshot: LOAN.repaymentPeriodDays,
      maxAmountSnapshot: money(maxAmount),
      groupAdminApprovedAt: adminApprovedAt,
      groupAdminApprovedById: adminApprovedAt ? adminId : null,
      treasurerApprovedAt: treasurerApprovedAt,
      treasurerApprovedById: treasurerApprovedAt ? treasurerId : null,
      rejectionReason: rejection?.reason ?? null,
      rejectedAt: rejection?.at ?? null,
      rejectedByUserId: rejection ? uid(rejection.by) : null,
      createdAt: appliedAt,
    });

    if (status === LoanApplicationStatus.PENDING) {
      openLoanUntil.set(person.key, new Date(8.64e15));
    }

    function buildLoan(disbursedAt: Date) {
      const loanId = randomUUID();
      const totalRepayable = round2(principal * (1 + LOAN.interestRate / 100));
      const dueDate = addDays(disbursedAt, LOAN.repaymentPeriodDays); // term counts from disbursement
      let repaid = 0;
      let lastPaymentAt: Date | null = null;

      note(
        userId,
        NotificationAudience.MEMBER,
        NotificationType.LOAN_DISBURSED,
        'Loan disbursed',
        `Your ${amount0} RWF loan in ${g} is now active. Repay on schedule to avoid penalties.`,
        addHours(disbursedAt, 0.02),
        { memberLoanId: loanId, groupName: g },
      );

      for (const rp of plan.repayments ?? []) {
        const t = addHours(atUtc(plan.appliedOn, 11), rp.afterDays * 24 + randInt(0, 6));
        if (t > today) continue;
        const remaining = round2(totalRepayable - repaid);
        if (remaining < 0.01) break;
        let amount = rp.rest
          ? remaining
          : rp.amount ?? round100(totalRepayable * (rp.portion ?? 0));
        amount = Math.min(round2(amount), remaining);
        if (amount <= 0) continue;
        const method = rp.method ?? 'MOMO';
        const depositId = randomUUID();
        const base = {
          id: depositId,
          userId,
          groupId,
          memberLoanId: loanId,
          amount: money(amount),
          currency: CURRENCY,
          contributionPortion: money(0),
          finePortion: money(0),
          installmentPortion: money(amount),
          purpose: DepositPurpose.LOAN_REPAYMENT,
          createdAt: t,
        };
        const allocate = (at: Date) =>
          allocations.push({
            depositId,
            kind: AllocationKind.LOAN_REPAYMENT,
            amount: money(amount),
            memberLoanId: loanId,
            createdAt: at,
          });

        if (method === 'MOMO') {
          deposits.push({
            ...base,
            paymentMethod: DepositPaymentMethod.MTN_MOMO,
            phone: person.phone,
            status: DepositRecordStatus.CONFIRMED,
            reviewedAt: t,
            externalReference: randomUUID(),
            providerStatus: 'SUCCESSFUL',
          });
          allocate(t);
          repaid = round2(repaid + amount);
          lastPaymentAt = t;
          note(
            userId,
            NotificationAudience.MEMBER,
            NotificationType.LOAN_REPAYMENT_RECORDED,
            'Loan payment recorded',
            `Your ${fmt2(amount)} ${CURRENCY} loan payment was applied in ${g}.`,
            addHours(t, 0.02),
            { groupName: g, amount: fmt2(amount), currency: CURRENCY },
          );
          continue;
        }

        // Manual transfer (loan)
        note(
          userId,
          NotificationAudience.MEMBER,
          NotificationType.PAYMENT_PROOF_SUBMITTED,
          'Loan repayment received',
          `We received your ${fmt2(amount)} ${CURRENCY} loan repayment proof in ${g}. A group admin or treasurer will review it.`,
          addHours(t, 0.02),
          { groupName: g },
        );
        noteLeaders(
          null,
          NotificationType.DEPOSIT_MANUAL_PENDING,
          'Loan repayment proof to review',
          `${person.fullName} submitted a loan repayment transfer (${fmt2(amount)} ${CURRENCY}) in ${g}.`,
          addHours(t, 0.03),
          { groupName: g, depositId, amount: fmt2(amount), currency: CURRENCY },
        );
        const reviewAt = addHours(t, randInt(2, 26));
        if (method === 'MANUAL_PENDING' || reviewAt > today) {
          deposits.push({
            ...base,
            paymentMethod: DepositPaymentMethod.MANUAL_TRANSFER,
            status: DepositRecordStatus.PENDING_VERIFICATION,
            proofImageUrl: PROOF_IMAGE_URL,
          });
          continue;
        }
        const reviewerKey =
          person.key === 'admin' ? 'treasurer' : person.key === 'treasurer' ? 'admin' : 'treasurer';
        deposits.push({
          ...base,
          paymentMethod: DepositPaymentMethod.MANUAL_TRANSFER,
          status: DepositRecordStatus.CONFIRMED,
          proofImageUrl: PROOF_IMAGE_URL,
          reviewedAt: reviewAt,
          reviewedByUserId: uid(reviewerKey),
        });
        allocate(reviewAt);
        repaid = round2(repaid + amount);
        lastPaymentAt = reviewAt;
        note(
          userId,
          NotificationAudience.MEMBER,
          NotificationType.LOAN_REPAYMENT_APPLIED,
          'Loan repayment confirmed',
          `Your loan repayment of ${fmt2(amount)} ${CURRENCY} was confirmed in ${g}.`,
          reviewAt,
          { groupName: g, amount: fmt2(amount), currency: CURRENCY },
        );
        const otherKey = otherLeaderKey(reviewerKey);
        note(
          uid(otherKey),
          otherKey === 'admin' ? NotificationAudience.GROUP_ADMIN : NotificationAudience.TREASURER,
          NotificationType.MANUAL_DEPOSIT_AUDIT_CONFIRM,
          'Manual payment confirmed',
          `A ${fmt2(amount)} ${CURRENCY} transfer from ${person.fullName} was confirmed in ${g}.`,
          addHours(reviewAt, 0.05),
          { groupName: g },
        );
      }

      const outstanding = round2(Math.max(0, totalRepayable - repaid));
      let loanStatus: MemberLoanStatus =
        outstanding < 0.01
          ? MemberLoanStatus.REPAID
          : plan.outcome === 'DEFAULTED'
            ? MemberLoanStatus.DEFAULTED
            : MemberLoanStatus.ACTIVE;

      // Penalty: penaltyRate % of outstanding for each started 30 days past (due + grace)
      let penaltyAccrued = 0;
      let penaltyPeriodsApplied = 0;
      const penaltyStart = addDays(dueDate, LOAN.gracePeriodDays);
      if (loanStatus !== MemberLoanStatus.REPAID && today > penaltyStart) {
        penaltyPeriodsApplied =
          Math.floor((today.getTime() - penaltyStart.getTime()) / (LOAN.penaltyPeriodDays * DAY)) + 1;
        penaltyAccrued = round2(outstanding * (LOAN.penaltyRate / 100) * penaltyPeriodsApplied);
      }
      if (plan.outcome === 'DEFAULTED' && loanStatus === MemberLoanStatus.ACTIVE) {
        loanStatus = MemberLoanStatus.DEFAULTED;
      }
      const defaultedAt =
        loanStatus === MemberLoanStatus.DEFAULTED
          ? (() => {
              const d = addDays(penaltyStart, LOAN.defaultAfterDays);
              return d < today ? d : addHours(today, -1);
            })()
          : null;

      loans.push({
        id: loanId,
        userId,
        groupId,
        applicationId: appId,
        principalAmount: money(principal),
        totalRepayable: money(totalRepayable),
        amountRepaid: money(repaid),
        currency: CURRENCY,
        interestRateSnapshot: money(LOAN.interestRate),
        repaymentPeriodDaysSnapshot: LOAN.repaymentPeriodDays,
        disbursedAt,
        dueDate,
        status: loanStatus,
        penaltyAccrued: money(penaltyAccrued),
        penaltyPeriodsApplied,
        lastPenaltyAt:
          penaltyPeriodsApplied > 0
            ? addDays(penaltyStart, (penaltyPeriodsApplied - 1) * LOAN.penaltyPeriodDays)
            : null,
        defaultedAt,
        createdAt: disbursedAt,
      });
      disbursements.push({
        id: randomUUID(),
        memberLoanId: loanId,
        groupId,
        amount: money(principal),
        currency: CURRENCY,
        method: LoanDisbursementMethod.RECORDED,
        status: LoanDisbursementStatus.COMPLETED,
        disbursedById: treasurerId,
        completedAt: disbursedAt,
        createdAt: disbursedAt,
      });

      openLoanUntil.set(
        person.key,
        loanStatus === MemberLoanStatus.REPAID && lastPaymentAt ? lastPaymentAt : new Date(8.64e15),
      );
    }
  });

  return {
    contributions,
    deposits,
    applications,
    loans,
    disbursements,
    fines,
    allocations,
    notifications,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB writers
// ─────────────────────────────────────────────────────────────────────────────

async function createManyChunked<T>(
  rows: T[],
  write: (chunk: T[]) => Promise<unknown>,
  size = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await write(rows.slice(i, i + size));
  }
}

export interface SeedDetailedGroupOptions {
  /** bcrypt hash used for every seeded user (seed.ts passes its SEED_PASSWORD hash). */
  passwordHash: string;
  /** Override "today" (defaults to now). */
  today?: Date;
  /** Print a summary table (default true). */
  log?: boolean;
}

export async function seedDetailedGroup(
  prisma: PrismaClient,
  options: SeedDetailedGroupOptions,
): Promise<{ groupId: string }> {
  const today = options.today ?? new Date();
  const log = options.log ?? true;

  // Roles (seed.ts creates them, but keep this file self-sufficient)
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  }
  const roles = await prisma.role.findMany();
  const roleId = (name: RoleName) => roles.find((r) => r.name === name)!.id;

  // Fresh start: deleting the group cascades to memberships, configs,
  // contributions, loans, deposits and group notifications.
  await prisma.group.deleteMany({ where: { name: DETAILED_GROUP_NAME } });

  // Users
  const userIds: Record<string, string> = {};
  for (const p of DETAILED_PEOPLE) {
    const email = detailedEmail(p);
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        fullName: p.fullName,
        passwordHash: options.passwordHash,
        phoneNumber: p.phone,
        isActive: true,
        emailVerified: true,
        createdAt: addDays(atUtc(p.joinedOn), -1),
      },
      update: {
        fullName: p.fullName,
        passwordHash: options.passwordHash,
        phoneNumber: p.phone,
        isActive: true,
        emailVerified: true,
        emailVerificationOtpHash: null,
        emailVerificationExpiresAt: null,
      },
    });
    await prisma.userPlatformRole.upsert({
      where: { userId: user.id },
      create: { userId: user.id, roleId: roleId(RoleName.USER) },
      update: { roleId: roleId(RoleName.USER) },
    });
    userIds[p.key] = user.id;
  }

  // Group + rules + memberships
  const groupId = randomUUID();
  await prisma.group.create({
    data: {
      id: groupId,
      name: DETAILED_GROUP_NAME,
      description:
        'Weekly savings & credit group (ikimina). 5,000 RWF every Friday, 10% late fine after a 2-day grace period. ' +
        'Loans up to 3× your savings at 5% flat interest over 90 days; both the group admin and the treasurer must approve.',
      isPublic: false,
      isVerified: true,
      verificationStatus: GroupVerificationStatus.VERIFIED,
      verificationRequestedAt: atUtc('2025-12-01', 10),
      verificationReviewedAt: atUtc('2025-12-02', 9),
      verificationDetails: { district: 'Gasabo', sector: 'Kimironko', cell: 'Bibare' },
      minMembers: 30, // used as the member cap by the API
      createdById: userIds.admin,
      createdAt: atUtc('2025-12-01', 7),
    },
  });

  await prisma.contributionConfig.create({
    data: {
      groupId,
      amount: money(CONTRIBUTION.amount),
      currency: CURRENCY,
      interval: CONTRIBUTION.interval,
      startDate: atUtc(FIRST_DUE_YMD),
      dayOfWeek: CONTRIBUTION.dayOfWeek,
      dayOfMonth: null,
      allowPartialPayments: CONTRIBUTION.allowPartialPayments,
      latePenaltyRate: money(CONTRIBUTION.latePenaltyRate),
      gracePeriodDays: CONTRIBUTION.gracePeriodDays,
      createdAt: atUtc('2025-12-01', 8),
    },
  });

  await prisma.loanConfig.create({
    data: {
      groupId,
      interestRate: money(LOAN.interestRate),
      repaymentPeriodDays: LOAN.repaymentPeriodDays,
      allowExceedContribution: LOAN.allowExceedContribution,
      maxLoanMultiplier: money(LOAN.maxLoanMultiplier),
      allowPartialPayments: LOAN.allowPartialPayments,
      penaltyRate: money(LOAN.penaltyRate),
      gracePeriodDays: LOAN.gracePeriodDays,
      penaltyPeriodDays: LOAN.penaltyPeriodDays,
      defaultAfterDays: LOAN.defaultAfterDays,
      blockIfArrears: LOAN.blockIfArrears,
      createdAt: atUtc('2025-12-01', 8),
    },
  });

  await prisma.userGroup.createMany({
    data: DETAILED_PEOPLE.map((p) => ({
      userId: userIds[p.key],
      groupId,
      roleId: roleId(p.role),
      joinedAt: atUtc(p.joinedOn, 9),
      membershipStatus: GroupMembershipStatus.ACTIVE,
    })),
  });

  // Financial history
  const plan = planDetailedGroup({ today, groupId, userIds });

  await createManyChunked(plan.contributions, (data) => prisma.contribution.createMany({ data }));
  await createManyChunked(plan.applications, (data) => prisma.loanApplication.createMany({ data }));
  await createManyChunked(plan.loans, (data) => prisma.memberLoan.createMany({ data }));
  await createManyChunked(plan.disbursements, (data) => prisma.loanDisbursement.createMany({ data }));
  await createManyChunked(plan.deposits, (data) => prisma.depositRecord.createMany({ data }));
  await createManyChunked(plan.fines, (data) => prisma.fine.createMany({ data }));
  await createManyChunked(plan.allocations, (data) => prisma.depositAllocation.createMany({ data }));
  await createManyChunked(plan.notifications, (data) => prisma.userNotification.createMany({ data }));

  if (log) printSummary(plan, today);
  return { groupId };
}

/** Deletes the detailed group (cascades all its data). Optionally deletes its yopmail users too. */
export async function removeDetailedGroup(
  prisma: PrismaClient,
  options: { deleteUsers?: boolean } = {},
): Promise<void> {
  const { count } = await prisma.group.deleteMany({ where: { name: DETAILED_GROUP_NAME } });
  let users = 0;
  if (options.deleteUsers) {
    const res = await prisma.user.deleteMany({
      where: { email: { in: DETAILED_PEOPLE.map(detailedEmail) } },
    });
    users = res.count;
  }
  console.log(`Removed "${DETAILED_GROUP_NAME}" (${count} group, ${users} users).`);
}

function printSummary(plan: DetailedGroupPlan, today: Date) {
  const countBy = <T, K extends string>(rows: T[], key: (r: T) => K) =>
    rows.reduce<Record<string, number>>((acc, r) => {
      const k = key(r);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const fmt = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

  console.log(`
Detailed group "${DETAILED_GROUP_NAME}" seeded (history up to ${today.toISOString().slice(0, 10)})
  contributions : ${plan.contributions.length}  (${fmt(countBy(plan.contributions, (r) => String(r.status)))})
  deposits      : ${plan.deposits.length}  (${fmt(countBy(plan.deposits, (r) => String(r.status)))})
  loan apps     : ${plan.applications.length}  (${fmt(countBy(plan.applications, (r) => String(r.status)))})
  member loans  : ${plan.loans.length}  (${fmt(countBy(plan.loans, (r) => String(r.status)))})
  fines         : ${plan.fines.length}  (${fmt(countBy(plan.fines, (r) => String(r.status)))})
  allocations   : ${plan.allocations.length}
  notifications : ${plan.notifications.length}
  Users (same password as the main seed):`);
  for (const p of DETAILED_PEOPLE) {
    const extra = [
      p.profile,
      p.stopsPayingLastWeeks ? `behind ${p.stopsPayingLastWeeks} wks` : '',
      p.pendingManualLatest ? 'pending manual proof' : '',
    ]
      .filter(Boolean)
      .join(', ');
    console.log(`    ${p.role.padEnd(12)} ${detailedEmail(p).padEnd(38)} ${p.fullName}  [${extra}]`);
  }
  for (const w of plan.warnings) console.warn(`  ⚠ ${w}`);
}
