-- AI assistant: conversation goals, human-takeover pause, neutral disclosure
-- (the default no longer says every reply is checked, since auto mode exists).
ALTER TABLE "AiAssistant" ADD COLUMN "goals" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiAssistant" ADD COLUMN "humanPauseHours" INTEGER NOT NULL DEFAULT 12;
ALTER TABLE "AiAssistant" ALTER COLUMN "disclosureText" SET DEFAULT '（我是 AI 小助理，需要時本人會親自回覆你）';
