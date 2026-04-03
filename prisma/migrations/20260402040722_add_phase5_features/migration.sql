-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED');

-- CreateTable
CREATE TABLE "RetentionRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "senderName" TEXT,
    "keepCount" INTEGER,
    "keepDays" INTEGER,
    "schedule" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetentionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamInvite" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "inviteeEmail" TEXT NOT NULL,
    "inviteeId" TEXT,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RetentionRule_userId_idx" ON "RetentionRule"("userId");

-- CreateIndex
CREATE INDEX "TeamInvite_inviteeEmail_idx" ON "TeamInvite"("inviteeEmail");

-- CreateIndex
CREATE UNIQUE INDEX "TeamInvite_ownerId_inviteeEmail_key" ON "TeamInvite"("ownerId", "inviteeEmail");

-- AddForeignKey
ALTER TABLE "RetentionRule" ADD CONSTRAINT "RetentionRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionRule" ADD CONSTRAINT "RetentionRule_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamInvite" ADD CONSTRAINT "TeamInvite_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamInvite" ADD CONSTRAINT "TeamInvite_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
