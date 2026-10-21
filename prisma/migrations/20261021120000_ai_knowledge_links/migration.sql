-- AI assistant: knowledge entries, sendable links, and gap tracking on drafts.
CREATE TABLE "AiKnowledgeEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiKnowledgeEntry_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AiLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiLink_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiKnowledgeEntry_instagramAccountId_position_idx" ON "AiKnowledgeEntry"("instagramAccountId", "position");
CREATE INDEX "AiLink_instagramAccountId_position_idx" ON "AiLink"("instagramAccountId", "position");
ALTER TABLE "AiKnowledgeEntry" ADD CONSTRAINT "AiKnowledgeEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiKnowledgeEntry" ADD CONSTRAINT "AiKnowledgeEntry_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiLink" ADD CONSTRAINT "AiLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiLink" ADD CONSTRAINT "AiLink_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiDraft" ADD COLUMN "actionLinkId" TEXT;
ALTER TABLE "AiDraft" ADD COLUMN "knowledgeGap" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiDraft" ADD COLUMN "gapQuestion" TEXT;
