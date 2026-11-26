-- CreateEnum
CREATE TYPE "GroupVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FineType" AS ENUM ('LATE_CONTRIBUTION', 'LATE_LOAN', 'ABSENCE', 'MISCONDUCT', 'OTHER');

-- CreateEnum
CREATE TYPE "FineStatus" AS ENUM ('OPEN', 'PAID', 'WAIVED');

-- CreateEnum
CREATE TYPE "DepositPurpose" AS ENUM ('CONTRIBUTION', 'LOAN_REPAYMENT', 'COMBINED');

-- CreateEnum
CREATE TYPE "AllocationKind" AS ENUM ('CONTRIBUTION', 'FINE', 'LOAN_PENALTY', 'LOAN_REPAYMENT');

-- CreateEnum
CREATE TYPE "LoanDisbursementMethod" AS ENUM ('MTN_MOMO', 'CASH', 'BANK_TRANSFER', 'RECORDED');

-- CreateEnum
CREATE TYPE "LoanDisbursementStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- AlterEnum
ALTER TYPE "ContributionStatus" ADD VALUE 'PARTIALLY_PAID';

-- AlterEnum
ALTER TYPE "DepositRecordStatus" ADD VALUE 'FAILED';

-- AlterEnum
ALTER TYPE "MemberLoanStatus" ADD VALUE 'WRITTEN_OFF';

-- AlterEnum
ALTER TYPE "NotificationAudience" ADD VALUE 'SUPER_ADMIN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'CONTRIBUTION_DUE_SOON';
ALTER TYPE "NotificationType" ADD VALUE 'CONTRIBUTION_LATE';
ALTER TYPE "NotificationType" ADD VALUE 'FINE_ISSUED';
ALTER TYPE "NotificationType" ADD VALUE 'FINE_WAIVED';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_PENALTY_APPLIED';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_DEFAULTED';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_WRITTEN_OFF';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_EXTENDED';
ALTER TYPE "NotificationType" ADD VALUE 'DEPOSIT_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_DISBURSEMENT_FAILED';
ALTER TYPE "NotificationType" ADD VALUE 'GROUP_VERIFICATION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'GROUP_VERIFIED';
ALTER TYPE "NotificationType" ADD VALUE 'GROUP_VERIFICATION_REJECTED';

-- AlterTable
ALTER TABLE "contribution_config" ADD COLUMN     "reminderDaysBefore" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "contributions" ADD COLUMN     "amountPaid" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "lateMarkedAt" TIMESTAMP(3),
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "deposit_records" ADD COLUMN     "externalReference" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "providerPayload" JSONB,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "providerTransactionId" TEXT,
ADD COLUMN     "purpose" "DepositPurpose" NOT NULL DEFAULT 'CONTRIBUTION';

-- AlterTable
ALTER TABLE "groups" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletionReason" TEXT,
ADD COLUMN     "verificationDetails" JSONB,
ADD COLUMN     "verificationRejectionReason" TEXT,
ADD COLUMN     "verificationRequestedAt" TIMESTAMP(3),
ADD COLUMN     "verificationReviewedAt" TIMESTAMP(3),
ADD COLUMN     "verificationReviewedById" TEXT,
ADD COLUMN     "verificationStatus" "GroupVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
ALTER COLUMN "isVerified" SET DEFAULT false;

-- AlterTable
ALTER TABLE "loan_config" ADD COLUMN     "blockIfArrears" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "defaultAfterDays" INTEGER,
ADD COLUMN     "penaltyPeriodDays" INTEGER NOT NULL DEFAULT 30;

-- AlterTable
ALTER TABLE "member_loans" ADD COLUMN     "defaultedAt" TIMESTAMP(3),
ADD COLUMN     "lastPenaltyAt" TIMESTAMP(3),
ADD COLUMN     "originalDueDate" TIMESTAMP(3),
ADD COLUMN     "penaltyPeriodsApplied" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "writeOffReason" TEXT,
ADD COLUMN     "writtenOffAmount" DECIMAL(10,2),
ADD COLUMN     "writtenOffAt" TIMESTAMP(3),
ADD COLUMN     "writtenOffById" TEXT;

-- CreateTable
CREATE TABLE "fines" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "FineType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "amountPaid" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'RWF',
    "reason" TEXT NOT NULL,
    "status" "FineStatus" NOT NULL DEFAULT 'OPEN',
    "contributionId" TEXT,
    "memberLoanId" TEXT,
    "issuedById" TEXT,
    "waivedById" TEXT,
    "waivedReason" TEXT,
    "waivedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_allocations" (
    "id" TEXT NOT NULL,
    "depositId" TEXT NOT NULL,
    "kind" "AllocationKind" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "contributionId" TEXT,
    "fineId" TEXT,
    "memberLoanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_disbursements" (
    "id" TEXT NOT NULL,
    "memberLoanId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RWF',
    "method" "LoanDisbursementMethod" NOT NULL,
    "status" "LoanDisbursementStatus" NOT NULL DEFAULT 'PENDING',
    "phone" TEXT,
    "reference" TEXT,
    "providerTransactionId" TEXT,
    "providerStatus" TEXT,
    "providerPayload" JSONB,
    "failureReason" TEXT,
    "proofImageUrl" TEXT,
    "disbursedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loan_disbursements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fines_contributionId_key" ON "fines"("contributionId");

-- CreateIndex
CREATE INDEX "fines_groupId_userId_status_idx" ON "fines"("groupId", "userId", "status");

-- CreateIndex
CREATE INDEX "fines_groupId_status_createdAt_idx" ON "fines"("groupId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "deposit_allocations_depositId_idx" ON "deposit_allocations"("depositId");

-- CreateIndex
CREATE INDEX "deposit_allocations_contributionId_idx" ON "deposit_allocations"("contributionId");

-- CreateIndex
CREATE INDEX "deposit_allocations_fineId_idx" ON "deposit_allocations"("fineId");

-- CreateIndex
CREATE INDEX "deposit_allocations_memberLoanId_idx" ON "deposit_allocations"("memberLoanId");

-- CreateIndex
CREATE UNIQUE INDEX "loan_disbursements_memberLoanId_key" ON "loan_disbursements"("memberLoanId");

-- CreateIndex
CREATE UNIQUE INDEX "loan_disbursements_reference_key" ON "loan_disbursements"("reference");

-- CreateIndex
CREATE INDEX "loan_disbursements_groupId_status_idx" ON "loan_disbursements"("groupId", "status");

-- CreateIndex
CREATE INDEX "contributions_groupId_status_dueDate_idx" ON "contributions"("groupId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_records_externalReference_key" ON "deposit_records"("externalReference");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_records_idempotencyKey_key" ON "deposit_records"("idempotencyKey");

-- CreateIndex
CREATE INDEX "deposit_records_status_paymentMethod_createdAt_idx" ON "deposit_records"("status", "paymentMethod", "createdAt");

-- CreateIndex
CREATE INDEX "groups_verificationStatus_idx" ON "groups"("verificationStatus");

-- CreateIndex
CREATE INDEX "groups_deletedAt_idx" ON "groups"("deletedAt");

-- CreateIndex
CREATE INDEX "member_loans_status_dueDate_idx" ON "member_loans"("status", "dueDate");

-- AddForeignKey
ALTER TABLE "fines" ADD CONSTRAINT "fines_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fines" ADD CONSTRAINT "fines_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fines" ADD CONSTRAINT "fines_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "contributions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fines" ADD CONSTRAINT "fines_memberLoanId_fkey" FOREIGN KEY ("memberLoanId") REFERENCES "member_loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_allocations" ADD CONSTRAINT "deposit_allocations_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "deposit_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_allocations" ADD CONSTRAINT "deposit_allocations_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "contributions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_allocations" ADD CONSTRAINT "deposit_allocations_fineId_fkey" FOREIGN KEY ("fineId") REFERENCES "fines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_allocations" ADD CONSTRAINT "deposit_allocations_memberLoanId_fkey" FOREIGN KEY ("memberLoanId") REFERENCES "member_loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_disbursements" ADD CONSTRAINT "loan_disbursements_memberLoanId_fkey" FOREIGN KEY ("memberLoanId") REFERENCES "member_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_disbursements" ADD CONSTRAINT "loan_disbursements_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Data backfill ────────────────────────────────────────────────────────────
-- Existing verified groups stay verified (new groups now start UNVERIFIED).
UPDATE "groups" SET "verificationStatus" = 'VERIFIED' WHERE "isVerified" = true;

-- Fully paid rows: amountPaid = amount.
UPDATE "contributions" SET "amountPaid" = "amount" WHERE "status" = 'PAID';

-- Deposits tied to a loan were loan repayments.
UPDATE "deposit_records" SET "purpose" = 'LOAN_REPAYMENT' WHERE "memberLoanId" IS NOT NULL;

-- Existing loans were "disbursed" on approval with no payout rail.
INSERT INTO "loan_disbursements"
  ("id", "memberLoanId", "groupId", "amount", "currency", "method", "status", "completedAt", "createdAt", "updatedAt")
SELECT 'ld_' || ml."id", ml."id", ml."groupId", ml."principalAmount", ml."currency",
       'RECORDED', 'COMPLETED', ml."disbursedAt", ml."disbursedAt", CURRENT_TIMESTAMP
FROM "member_loans" ml
WHERE NOT EXISTS (SELECT 1 FROM "loan_disbursements" ld WHERE ld."memberLoanId" = ml."id");
