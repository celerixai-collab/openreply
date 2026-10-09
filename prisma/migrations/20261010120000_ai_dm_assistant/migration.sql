-- AI DM assistant (draft mode): one assistant per connected Instagram
-- account (off by default) and the drafts it writes for inbound DMs. Nothing
-- is sent until a draft is approved. Additive only: two new tables and an
-- enum, no existing column changes.
-- CreateEnum
CREATE TYPE "AiDraftStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'DISMISSED', 'EXPIRED', 'FAILED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "AiAssistant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'draft',
    "model" TEXT NOT NULL DEFAULT 'claude-haiku-5-5',
    "role" TEXT NOT NULL DEFAULT '',
    "voice" TEXT NOT NULL DEFAULT '',
    "guardrails" TEXT NOT NULL DEFAULT '',
    "knowledge" TEXT NOT NULL DEFAULT '',
    "disclosureText" TEXT NOT NULL DEFAULT '（我是 AI 小助理，訊息經過本人確認後送出）',
    "dailyDraftCapPerPerson" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAssistant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDraft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "contactId" TEXT,
    "igsid" TEXT NOT NULL,
    "username" TEXT,
    "inboundMessageId" TEXT NOT NULL,
    "inboundText" TEXT NOT NULL,
    "inboundAt" TIMESTAMP(3) NOT NULL,
    "historySnapshot" JSONB NOT NULL,
    "draftText" TEXT NOT NULL DEFAULT '',
    "intent" TEXT,
    "needsHuman" BOOLEAN NOT NULL DEFAULT false,
    "handoffReason" TEXT,
    "language" TEXT,
    "confidence" TEXT,
    "status" "AiDraftStatus" NOT NULL DEFAULT 'PENDING',
    "finalText" TEXT,
    "error" TEXT,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentMessageId" TEXT,

    CONSTRAINT "AiDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiAssistant_instagramAccountId_key" ON "AiAssistant"("instagramAccountId");

-- CreateIndex
CREATE INDEX "AiAssistant_workspaceId_idx" ON "AiAssistant"("workspaceId");

-- CreateIndex
CREATE INDEX "AiDraft_workspaceId_status_createdAt_idx" ON "AiDraft"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AiDraft_instagramAccountId_igsid_createdAt_idx" ON "AiDraft"("instagramAccountId", "igsid", "createdAt");

-- CreateIndex
CREATE INDEX "AiDraft_contactId_idx" ON "AiDraft"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "AiDraft_instagramAccountId_inboundMessageId_key" ON "AiDraft"("instagramAccountId", "inboundMessageId");

-- AddForeignKey
ALTER TABLE "AiAssistant" ADD CONSTRAINT "AiAssistant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiAssistant" ADD CONSTRAINT "AiAssistant_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

