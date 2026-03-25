-- CreateTable
CREATE TABLE "SearchRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByEmail" TEXT NOT NULL,
    "borrowerName" TEXT NOT NULL,
    "borrowerIdCode" TEXT,
    "loanReference" TEXT,
    "providerKey" TEXT NOT NULL,
    "driveFolderUrl" TEXT NOT NULL,
    "resultStatus" TEXT NOT NULL,
    "resultsCount" INTEGER NOT NULL,
    "matchedSummary" TEXT,
    "uploadedFileId" TEXT,
    "uploadedFileUrl" TEXT,
    "requestPayloadJson" TEXT,
    "normalizedResultJson" TEXT
);
