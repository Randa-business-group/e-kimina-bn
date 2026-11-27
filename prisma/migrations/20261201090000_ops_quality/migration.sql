-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD');

-- AlterTable
ALTER TABLE "contribution_config" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "contributions" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "amountPaid" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "deposit_allocations" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "deposit_records" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "contributionPortion" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "finePortion" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "installmentPortion" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "platformFee" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "fines" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "amountPaid" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "groups" ALTER COLUMN "defaultAbsenceFine" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "defaultLateArrivalFine" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "loan_applications" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'RWF',
ADD COLUMN     "idempotencyKey" TEXT,
ALTER COLUMN "requestedAmount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "maxAmountSnapshot" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "loan_disbursements" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "loan_guarantors" ALTER COLUMN "amountGuaranteed" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "calledAmount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "paidAmount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "loan_installments" ALTER COLUMN "principal" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "interest" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "amountPaid" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "meetings" ALTER COLUMN "absenceFine" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "lateFine" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "member_loans" ALTER COLUMN "principalAmount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "totalRepayable" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "amountRepaid" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "penaltyAccrued" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "writtenOffAmount" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "rebateGranted" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "platform_settings" ALTER COLUMN "feeValue" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "feeMin" SET DATA TYPE DECIMAL(14,2),
ALTER COLUMN "feeMax" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "social_fund_config" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

-- AlterTable
ALTER TABLE "user_groups" ALTER COLUMN "customContributionAmount" SET DATA TYPE DECIMAL(14,2);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_status_runAt_idx" ON "jobs"("status", "runAt");

-- CreateIndex
CREATE INDEX "jobs_type_status_idx" ON "jobs"("type", "status");

-- CreateIndex
CREATE INDEX "jobs_dedupeKey_idx" ON "jobs"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "loan_applications_idempotencyKey_key" ON "loan_applications"("idempotencyKey");

-- Loan applications take the group's currency (contribution config), not a hard-coded RWF.
UPDATE "loan_applications" a SET "currency" = c."currency"
FROM "contribution_config" c WHERE c."groupId" = a."groupId";
UPDATE "member_loans" l SET "currency" = c."currency"
FROM "contribution_config" c WHERE c."groupId" = l."groupId" AND l."currency" <> c."currency";

-- One active job per dedupe key.
CREATE UNIQUE INDEX "jobs_active_dedupe_key" ON "jobs" ("dedupeKey") WHERE "dedupeKey" IS NOT NULL AND "status" IN ('PENDING', 'RUNNING');
