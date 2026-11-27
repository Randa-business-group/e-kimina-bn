-- CreateEnum
CREATE TYPE "ApprovalEntityType" AS ENUM ('LOAN_APPLICATION', 'EXPENSE');

-- CreateEnum
CREATE TYPE "ExitKind" AS ENUM ('VOLUNTARY', 'REMOVED');

-- CreateEnum
CREATE TYPE "ExitRequestStatus" AS ENUM ('PENDING', 'SETTLED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'HELD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED');

-- CreateEnum
CREATE TYPE "PollKind" AS ENUM ('GENERAL', 'ROLE_CHANGE', 'REMOVE_MEMBER', 'RULE_CHANGE');

-- CreateEnum
CREATE TYPE "PollStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "ContributionStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
ALTER TYPE "FineType" ADD VALUE 'LATE_ARRIVAL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GroupMembershipStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "GroupMembershipStatus" ADD VALUE 'EXITED';

-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'EXIT_REFUND';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ROLE_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'JOIN_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'JOIN_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'JOIN_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'EXIT_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'EXIT_SETTLED';
ALTER TYPE "NotificationType" ADD VALUE 'EXIT_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'MEETING_SCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE 'MEETING_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'MEETING_MINUTES_PUBLISHED';
ALTER TYPE "NotificationType" ADD VALUE 'CONSTITUTION_PUBLISHED';
ALTER TYPE "NotificationType" ADD VALUE 'POLL_OPENED';
ALTER TYPE "NotificationType" ADD VALUE 'POLL_CLOSED';

-- AlterTable
ALTER TABLE "groups" ADD COLUMN     "constitutionRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "defaultAbsenceFine" DECIMAL(10,2),
ADD COLUMN     "defaultLateArrivalFine" DECIMAL(10,2),
ADD COLUMN     "expenseApprovalsRequired" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "joinRequiresApproval" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "loanApprovalsRequired" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "loanRequireAdminAndTreasurer" BOOLEAN NOT NULL DEFAULT true;

-- The old "minMembers" column was always used as the member CAP: keep its data as "maxMembers"
-- and add a real minimum.
ALTER TABLE "groups" RENAME COLUMN "minMembers" TO "maxMembers";
ALTER TABLE "groups" ADD COLUMN "minMembers" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "user_groups" ADD COLUMN     "exitedAt" TIMESTAMP(3),
ADD COLUMN     "joinMessage" TEXT,
ADD COLUMN     "joinRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "entityType" "ApprovalEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "RoleName" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exit_requests" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ExitKind" NOT NULL,
    "status" "ExitRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "savingsBase" DECIMAL(14,2),
    "fineDeduction" DECIMAL(14,2),
    "loanDeduction" DECIMAL(14,2),
    "uncoveredDebt" DECIMAL(14,2),
    "refundAmount" DECIMAL(14,2),
    "method" TEXT,
    "reference" TEXT,
    "settledById" TEXT,
    "settledAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "agenda" TEXT,
    "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "minutesText" TEXT,
    "minutesUrl" TEXT,
    "absenceFine" DECIMAL(10,2),
    "lateFine" DECIMAL(10,2),
    "createdById" TEXT NOT NULL,
    "heldAt" TIMESTAMP(3),
    "finesIssuedAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_attendance" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "note" TEXT,
    "fineId" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_constitutions" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "documentUrl" TEXT,
    "summaryOfChanges" TEXT,
    "publishedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_constitutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "constitution_acceptances" (
    "id" TEXT NOT NULL,
    "constitutionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "constitution_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polls" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" "PollKind" NOT NULL,
    "payload" JSONB,
    "options" JSONB NOT NULL,
    "status" "PollStatus" NOT NULL DEFAULT 'OPEN',
    "anonymous" BOOLEAN NOT NULL DEFAULT true,
    "quorumPercent" INTEGER NOT NULL DEFAULT 50,
    "passPercent" INTEGER NOT NULL DEFAULT 50,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "result" JSONB,
    "executedAt" TIMESTAMP(3),
    "executionError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "polls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poll_votes" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "optionIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "poll_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_member_profiles" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nationalId" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "gender" TEXT,
    "address" TEXT,
    "occupation" TEXT,
    "nextOfKinName" TEXT,
    "nextOfKinPhone" TEXT,
    "nextOfKinRelationship" TEXT,
    "beneficiaryName" TEXT,
    "beneficiaryPhone" TEXT,
    "beneficiaryRelationship" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_member_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approvals_groupId_entityType_entityId_idx" ON "approvals"("groupId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_entityType_entityId_userId_key" ON "approvals"("entityType", "entityId", "userId");

-- CreateIndex
CREATE INDEX "exit_requests_groupId_status_idx" ON "exit_requests"("groupId", "status");

-- CreateIndex
CREATE INDEX "exit_requests_userId_status_idx" ON "exit_requests"("userId", "status");

-- CreateIndex
CREATE INDEX "meetings_groupId_scheduledAt_idx" ON "meetings"("groupId", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_attendance_meetingId_userId_key" ON "meeting_attendance"("meetingId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "group_constitutions_groupId_version_key" ON "group_constitutions"("groupId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "constitution_acceptances_constitutionId_userId_key" ON "constitution_acceptances"("constitutionId", "userId");

-- CreateIndex
CREATE INDEX "polls_groupId_status_idx" ON "polls"("groupId", "status");

-- CreateIndex
CREATE INDEX "polls_status_closesAt_idx" ON "polls"("status", "closesAt");

-- CreateIndex
CREATE UNIQUE INDEX "poll_votes_pollId_userId_key" ON "poll_votes"("pollId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "group_member_profiles_groupId_userId_key" ON "group_member_profiles"("groupId", "userId");

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_constitutions" ADD CONSTRAINT "group_constitutions_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constitution_acceptances" ADD CONSTRAINT "constitution_acceptances_constitutionId_fkey" FOREIGN KEY ("constitutionId") REFERENCES "group_constitutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polls" ADD CONSTRAINT "polls_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_member_profiles" ADD CONSTRAINT "group_member_profiles_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
