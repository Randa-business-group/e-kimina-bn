-- CreateEnum
CREATE TYPE "InterestMethod" AS ENUM ('FLAT', 'REDUCING');

-- CreateEnum
CREATE TYPE "InstallmentInterval" AS ENUM ('SINGLE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID', 'LATE');

-- CreateEnum
CREATE TYPE "GuarantorStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'DECLINED', 'RELEASED', 'CALLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'GUARANTOR_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'GUARANTOR_RESPONDED';
ALTER TYPE "NotificationType" ADD VALUE 'GUARANTEE_CALLED';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_INSTALLMENT_DUE';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_INSTALLMENT_LATE';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_APPLICATION_CANCELLED';

-- AlterTable
ALTER TABLE "deposit_records" ADD COLUMN     "earlyPayoff" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "loan_applications" ADD COLUMN     "attachmentUrls" JSONB,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "installmentIntervalSnapshot" "InstallmentInterval" NOT NULL DEFAULT 'SINGLE',
ADD COLUMN     "interestMethodSnapshot" "InterestMethod" NOT NULL DEFAULT 'FLAT',
ADD COLUMN     "purpose" TEXT,
ADD COLUMN     "topUpOfLoanId" TEXT;

-- AlterTable
ALTER TABLE "loan_config" ADD COLUMN     "allowTopUp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "earlyRepaymentRebatePercent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "guarantorsRequired" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "installmentInterval" "InstallmentInterval" NOT NULL DEFAULT 'SINGLE',
ADD COLUMN     "interestMethod" "InterestMethod" NOT NULL DEFAULT 'FLAT';

-- AlterTable
ALTER TABLE "member_loans" ADD COLUMN     "installmentIntervalSnapshot" "InstallmentInterval" NOT NULL DEFAULT 'SINGLE',
ADD COLUMN     "interestMethodSnapshot" "InterestMethod" NOT NULL DEFAULT 'FLAT',
ADD COLUMN     "rebateGranted" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "refinancedByLoanId" TEXT,
ADD COLUMN     "topUpOfLoanId" TEXT;

-- CreateTable
CREATE TABLE "loan_installments" (
    "id" TEXT NOT NULL,
    "memberLoanId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "principal" DECIMAL(10,2) NOT NULL,
    "interest" DECIMAL(10,2) NOT NULL,
    "amountPaid" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "penaltyPeriodsApplied" INTEGER NOT NULL DEFAULT 0,
    "lateMarkedAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loan_installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_guarantors" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "loanApplicationId" TEXT NOT NULL,
    "memberLoanId" TEXT,
    "guarantorUserId" TEXT NOT NULL,
    "amountGuaranteed" DECIMAL(10,2) NOT NULL,
    "status" "GuarantorStatus" NOT NULL DEFAULT 'REQUESTED',
    "respondedAt" TIMESTAMP(3),
    "calledAmount" DECIMAL(10,2),
    "calledAt" TIMESTAMP(3),
    "paidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loan_guarantors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loan_installments_status_dueDate_idx" ON "loan_installments"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "loan_installments_memberLoanId_number_key" ON "loan_installments"("memberLoanId", "number");

-- CreateIndex
CREATE INDEX "loan_guarantors_groupId_guarantorUserId_status_idx" ON "loan_guarantors"("groupId", "guarantorUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "loan_guarantors_loanApplicationId_guarantorUserId_key" ON "loan_guarantors"("loanApplicationId", "guarantorUserId");

-- AddForeignKey
ALTER TABLE "loan_installments" ADD CONSTRAINT "loan_installments_memberLoanId_fkey" FOREIGN KEY ("memberLoanId") REFERENCES "member_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_guarantors" ADD CONSTRAINT "loan_guarantors_loanApplicationId_fkey" FOREIGN KEY ("loanApplicationId") REFERENCES "loan_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_guarantors" ADD CONSTRAINT "loan_guarantors_memberLoanId_fkey" FOREIGN KEY ("memberLoanId") REFERENCES "member_loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Data backfill ────────────────────────────────────────────────────────────
-- Every existing loan becomes a one-installment schedule (same due date and amounts);
-- penalty periods already charged move to the installment so they are not charged twice.
INSERT INTO "loan_installments"
  ("id", "memberLoanId", "number", "dueDate", "principal", "interest", "amountPaid", "status",
   "paidAt", "penaltyPeriodsApplied", "createdAt", "updatedAt")
SELECT 'li_' || ml."id", ml."id", 1, ml."dueDate", ml."principalAmount",
       ml."totalRepayable" - ml."principalAmount",
       LEAST(ml."amountRepaid", ml."totalRepayable"),
       CASE
         WHEN ml."amountRepaid" >= ml."totalRepayable" THEN 'PAID'::"InstallmentStatus"
         WHEN ml."dueDate" < CURRENT_TIMESTAMP THEN 'LATE'::"InstallmentStatus"
         WHEN ml."amountRepaid" > 0 THEN 'PARTIALLY_PAID'::"InstallmentStatus"
         ELSE 'PENDING'::"InstallmentStatus"
       END,
       CASE WHEN ml."amountRepaid" >= ml."totalRepayable" THEN ml."updatedAt" END,
       ml."penaltyPeriodsApplied", ml."createdAt", CURRENT_TIMESTAMP
FROM "member_loans" ml
WHERE NOT EXISTS (SELECT 1 FROM "loan_installments" li WHERE li."memberLoanId" = ml."id");
