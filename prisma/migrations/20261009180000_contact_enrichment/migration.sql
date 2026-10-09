-- Contact enrichment: what brought each person in (their comment or DM),
-- the trigger behind a captured email, their Instagram profile (display
-- name, follower count, whether they follow) and a DM opt-out. Additive
-- only: every new column is nullable, existing rows read as unknown.

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "emailOptedOutAt" TIMESTAMP(3),
ADD COLUMN     "emailSourceKeyword" TEXT,
ADD COLUMN     "emailSourceMediaId" TEXT,
ADD COLUMN     "emailSourceText" TEXT,
ADD COLUMN     "emailSourceType" TEXT,
ADD COLUMN     "followerCount" INTEGER,
ADD COLUMN     "followsYou" BOOLEAN,
ADD COLUMN     "lastTriggerAt" TIMESTAMP(3),
ADD COLUMN     "lastTriggerKeyword" TEXT,
ADD COLUMN     "lastTriggerMediaId" TEXT,
ADD COLUMN     "lastTriggerText" TEXT,
ADD COLUMN     "lastTriggerType" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "profileCheckedAt" TIMESTAMP(3);
