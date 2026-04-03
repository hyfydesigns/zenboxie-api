-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AutoCleanRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectedAccountId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "senderName" TEXT,
    "permanent" BOOLEAN NOT NULL DEFAULT false,
    "schedule" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoCleanRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutoCleanRule_userId_idx" ON "AutoCleanRule"("userId");

-- AddForeignKey
ALTER TABLE "AutoCleanRule" ADD CONSTRAINT "AutoCleanRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoCleanRule" ADD CONSTRAINT "AutoCleanRule_connectedAccountId_fkey" FOREIGN KEY ("connectedAccountId") REFERENCES "ConnectedAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
