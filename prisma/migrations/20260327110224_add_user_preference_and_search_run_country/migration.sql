-- AlterTable
ALTER TABLE "SearchRun" ADD COLUMN "country" TEXT;

-- CreateTable
CREATE TABLE "UserPreference" (
    "email" TEXT NOT NULL PRIMARY KEY,
    "country" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
