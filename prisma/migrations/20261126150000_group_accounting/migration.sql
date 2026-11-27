-- CreateEnum
CREATE TYPE "FundType" AS ENUM ('SAVINGS', 'SOCIAL');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('CONTRIBUTION', 'FINE', 'LOAN_DISBURSEMENT', 'LOAN_PRINCIPAL', 'LOAN_INTEREST', 'LOAN_PENALTY', 'EXPENSE', 'SOCIAL_PAYOUT', 'SHARE_OUT', 'ROTATION_PAYOUT', 'OPENING_BALANCE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CycleStatus" AS ENUM ('ACTIVE', 'CLOSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "ShareOutStatus" AS ENUM ('PENDING', 'PAID', 'CARRIED_OVER');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('BANK_FEES', 'MEETING', 'STATIONERY', 'TRANSPORT', 'COMMUNICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SocialPayoutReason" AS ENUM ('FUNERAL', 'SICKNESS', 'WEDDING', 'BIRTH', 'ACCIDENT', 'OTHER');

-- CreateEnum
CREATE TYPE "SocialPayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayoutMode" AS ENUM ('SAVINGS_AND_LOANS', 'ROTATING');

-- CreateEnum
CREATE TYPE "RotationSlotStatus" AS ENUM ('UPCOMING', 'PAID', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SwapRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'SOCIAL_PAYOUT_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'SOCIAL_PAYOUT_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'SOCIAL_PAYOUT_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'SOCIAL_PAYOUT_PAID';
ALTER TYPE "NotificationType" ADD VALUE 'SHARE_OUT_PREPARED';
ALTER TYPE "NotificationType" ADD VALUE 'CYCLE_CLOSED';
ALTER TYPE "NotificationType" ADD VALUE 'SHARE_OUT_PAID';
ALTER TYPE "NotificationType" ADD VALUE 'ROTATION_PAYOUT_PAID';
ALTER TYPE "NotificationType" ADD VALUE 'ROTATION_SWAP_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'ROTATION_SWAP_RESPONDED';
ALTER TYPE "NotificationType" ADD VALUE 'LEDGER_ADJUSTMENT';

-- DropIndex
DROP INDEX "contributions_userId_groupId_dueDate_key";

-- AlterTable
ALTER TABLE "contribution_config" ADD COLUMN     "payoutMode" "PayoutMode" NOT NULL DEFAULT 'SAVINGS_AND_LOANS';

-- AlterTable
ALTER TABLE "contributions" ADD COLUMN     "cycleId" TEXT,
ADD COLUMN     "fund" "FundType" NOT NULL DEFAULT 'SAVINGS';

-- AlterTable
ALTER TABLE "fines" ADD COLUMN     "cycleId" TEXT;

-- AlterTable
ALTER TABLE "member_loans" ADD COLUMN     "cycleId" TEXT;

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycleId" TEXT,
    "userId" TEXT,
    "fund" "FundType" NOT NULL DEFAULT 'SAVINGS',
    "type" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "depositId" TEXT,
    "allocationId" TEXT,
    "contributionId" TEXT,
    "fineId" TEXT,
    "memberLoanId" TEXT,
    "disbursementId" TEXT,
    "expenseId" TEXT,
    "socialPayoutId" TEXT,
    "shareOutId" TEXT,
    "rotationSlotId" TEXT,
    "description" TEXT,
    "createdById" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_cycles" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "CycleStatus" NOT NULL DEFAULT 'ACTIVE',
    "preparedAt" TIMESTAMP(3),
    "preparedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closingSummary" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_outs" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "openingBalance" DECIMAL(14,2) NOT NULL,
    "savings" DECIMAL(14,2) NOT NULL,
    "profitShare" DECIMAL(14,2) NOT NULL,
    "grossAmount" DECIMAL(14,2) NOT NULL,
    "fineDeduction" DECIMAL(14,2) NOT NULL,
    "loanDeduction" DECIMAL(14,2) NOT NULL,
    "uncoveredDebt" DECIMAL(14,2) NOT NULL,
    "netPayout" DECIMAL(14,2) NOT NULL,
    "status" "ShareOutStatus" NOT NULL DEFAULT 'PENDING',
    "method" TEXT,
    "reference" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "share_outs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycleId" TEXT,
    "fund" "FundType" NOT NULL DEFAULT 'SAVINGS',
    "amount" DECIMAL(12,2) NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "receiptUrl" TEXT,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectionReason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_fund_config" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RWF',
    "interval" "ContributionInterval" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 0,
    "latePenaltyRate" DECIMAL(5,2),
    "reminderDaysBefore" INTEGER NOT NULL DEFAULT 1,
    "maxPayoutAmount" DECIMAL(12,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_fund_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_payouts" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycleId" TEXT,
    "beneficiaryUserId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" "SocialPayoutReason" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "SocialPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectionReason" TEXT,
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3),
    "method" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rotation_slots" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "cycleId" TEXT,
    "position" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "expectedAmount" DECIMAL(12,2) NOT NULL,
    "status" "RotationSlotStatus" NOT NULL DEFAULT 'UPCOMING',
    "paidAmount" DECIMAL(12,2),
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "method" TEXT,
    "reference" TEXT,
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rotation_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rotation_swap_requests" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "fromSlotId" TEXT NOT NULL,
    "toSlotId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "status" "SwapRequestStatus" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rotation_swap_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_sourceKey_key" ON "ledger_entries"("sourceKey");

-- CreateIndex
CREATE INDEX "ledger_entries_groupId_occurredAt_idx" ON "ledger_entries"("groupId", "occurredAt");

-- CreateIndex
CREATE INDEX "ledger_entries_groupId_fund_type_idx" ON "ledger_entries"("groupId", "fund", "type");

-- CreateIndex
CREATE INDEX "ledger_entries_groupId_cycleId_type_idx" ON "ledger_entries"("groupId", "cycleId", "type");

-- CreateIndex
CREATE INDEX "ledger_entries_groupId_userId_idx" ON "ledger_entries"("groupId", "userId");

-- CreateIndex
CREATE INDEX "group_cycles_groupId_status_idx" ON "group_cycles"("groupId", "status");

-- CreateIndex
CREATE INDEX "group_cycles_groupId_startDate_idx" ON "group_cycles"("groupId", "startDate");

-- CreateIndex
CREATE INDEX "share_outs_groupId_status_idx" ON "share_outs"("groupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "share_outs_cycleId_userId_key" ON "share_outs"("cycleId", "userId");

-- CreateIndex
CREATE INDEX "expenses_groupId_status_idx" ON "expenses"("groupId", "status");

-- CreateIndex
CREATE INDEX "expenses_groupId_occurredAt_idx" ON "expenses"("groupId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "social_fund_config_groupId_key" ON "social_fund_config"("groupId");

-- CreateIndex
CREATE INDEX "social_payouts_groupId_status_idx" ON "social_payouts"("groupId", "status");

-- CreateIndex
CREATE INDEX "rotation_slots_groupId_status_idx" ON "rotation_slots"("groupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rotation_slots_groupId_dueDate_key" ON "rotation_slots"("groupId", "dueDate");

-- CreateIndex
CREATE INDEX "rotation_swap_requests_groupId_status_idx" ON "rotation_swap_requests"("groupId", "status");

-- CreateIndex
CREATE INDEX "rotation_swap_requests_targetUserId_status_idx" ON "rotation_swap_requests"("targetUserId", "status");

-- CreateIndex
CREATE INDEX "contributions_cycleId_idx" ON "contributions"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "contributions_userId_groupId_fund_dueDate_key" ON "contributions"("userId", "groupId", "fund", "dueDate");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "group_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_cycles" ADD CONSTRAINT "group_cycles_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_outs" ADD CONSTRAINT "share_outs_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "group_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_fund_config" ADD CONSTRAINT "social_fund_config_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_payouts" ADD CONSTRAINT "social_payouts_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rotation_slots" ADD CONSTRAINT "rotation_slots_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
