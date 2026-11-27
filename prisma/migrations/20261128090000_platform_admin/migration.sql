-- CreateEnum
CREATE TYPE "CollectionMode" AS ENUM ('PLATFORM', 'PER_GROUP');

-- CreateEnum
CREATE TYPE "PlatformFeeMode" AS ENUM ('NONE', 'PERCENT', 'FLAT');

-- AlterTable
ALTER TABLE "deposit_records" ADD COLUMN     "platformFee" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedById" TEXT,
ADD COLUMN     "suspensionReason" TEXT;

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "actorName" TEXT,
    "actorRole" TEXT,
    "impersonatorId" TEXT,
    "action" TEXT NOT NULL,
    "method" TEXT,
    "path" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "groupId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "meta" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "statusCode" INTEGER,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "supportedCurrencies" TEXT[] DEFAULT ARRAY['RWF']::TEXT[],
    "defaultCurrency" TEXT NOT NULL DEFAULT 'RWF',
    "collectionMode" "CollectionMode" NOT NULL DEFAULT 'PLATFORM',
    "platformAccountName" TEXT,
    "platformAccountMsisdn" TEXT,
    "feeMode" "PlatformFeeMode" NOT NULL DEFAULT 'NONE',
    "feeValue" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "feeMin" DECIMAL(10,2),
    "feeMax" DECIMAL(10,2),
    "signupsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "supportEmail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_payment_accounts" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'MTN_MOMO',
    "accountName" TEXT,
    "msisdn" TEXT,
    "collectionUserId" TEXT,
    "collectionApiKeyEnc" TEXT,
    "collectionSubscriptionKeyEnc" TEXT,
    "disbursementUserId" TEXT,
    "disbursementApiKeyEnc" TEXT,
    "disbursementSubscriptionKeyEnc" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "group_payment_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_groupId_createdAt_idx" ON "audit_logs"("groupId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE UNIQUE INDEX "group_payment_accounts_groupId_key" ON "group_payment_accounts"("groupId");

-- AddForeignKey
ALTER TABLE "group_payment_accounts" ADD CONSTRAINT "group_payment_accounts_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
