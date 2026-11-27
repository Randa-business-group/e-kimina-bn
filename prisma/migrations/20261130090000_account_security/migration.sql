-- CreateEnum
CREATE TYPE "TwoFactorMethod" AS ENUM ('TOTP', 'SMS');

-- CreateEnum
CREATE TYPE "DeletionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "platform_settings" ADD COLUMN     "requireLeaderTwoFactor" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "otpFailedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN     "phoneKey" TEXT,
ADD COLUMN     "phoneOtpExpiresAt" TIMESTAMP(3),
ADD COLUMN     "phoneOtpHash" TEXT,
ADD COLUMN     "phoneOtpPurpose" TEXT,
ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "totpLastStep" INTEGER,
ADD COLUMN     "totpPendingSecretEnc" TEXT,
ADD COLUMN     "totpSecretEnc" TEXT,
ADD COLUMN     "twoFactorEnabledAt" TIMESTAMP(3),
ADD COLUMN     "twoFactorMethod" "TwoFactorMethod",
ADD COLUMN     "twoFactorRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sessionVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "replacedById" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_deletion_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "status" "DeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decisionNote" TEXT,

    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_revokedAt_idx" ON "refresh_tokens"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE INDEX "account_deletion_requests_status_requestedAt_idx" ON "account_deletion_requests"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "account_deletion_requests_userId_idx" ON "account_deletion_requests"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneKey_key" ON "users"("phoneKey");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill phoneKey from existing phone numbers (first account wins on duplicates).
WITH norm AS (
  SELECT id, "createdAt",
    CASE
      WHEN d ~ '^07[0-9]{8}$' THEN '250' || substr(d, 2)
      WHEN d ~ '^7[0-9]{8}$' THEN '250' || d
      WHEN d ~ '^00[0-9]{10,14}$' THEN substr(d, 3)
      WHEN d ~ '^[0-9]{10,15}$' THEN d
      ELSE NULL
    END AS k
  FROM (SELECT id, "createdAt", regexp_replace(coalesce("phoneNumber", ''), '[^0-9]', '', 'g') AS d FROM "users") x
), ranked AS (
  SELECT id, k, row_number() OVER (PARTITION BY k ORDER BY "createdAt") AS rn FROM norm WHERE k IS NOT NULL
)
UPDATE "users" u SET "phoneKey" = r.k FROM ranked r WHERE u.id = r.id AND r.rn = 1;
