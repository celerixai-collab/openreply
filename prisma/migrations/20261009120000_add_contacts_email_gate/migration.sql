-- Email gate: campaigns can require an email before delivering their link,
-- and the people a campaign matched are kept as contacts (with the email and
-- the exact ask text they answered). Additive only: existing campaigns keep
-- collectEmail = false and behave as before.

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "collectEmail" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailInvalidMessage" TEXT,
ADD COLUMN     "emailPromptMessage" TEXT,
ADD COLUMN     "emailQuickReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "emailThanksMessage" TEXT;

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "igsid" TEXT NOT NULL,
    "username" TEXT,
    "email" TEXT,
    "emailCapturedAt" TIMESTAMP(3),
    "emailAutomationId" TEXT,
    "emailSource" TEXT,
    "emailConsentText" TEXT,
    "pendingEmailAutomationId" TEXT,
    "pendingEmailPrompt" TEXT,
    "pendingEmailAttempts" INTEGER NOT NULL DEFAULT 0,
    "pendingEmailExpiresAt" TIMESTAMP(3),
    "pendingEmailSilenced" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInteractionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contact_workspaceId_emailCapturedAt_idx" ON "Contact"("workspaceId", "emailCapturedAt");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_email_idx" ON "Contact"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "Contact_emailAutomationId_idx" ON "Contact"("emailAutomationId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_instagramAccountId_igsid_key" ON "Contact"("instagramAccountId", "igsid");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_emailAutomationId_fkey" FOREIGN KEY ("emailAutomationId") REFERENCES "Automation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

