-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "analytics" BOOLEAN NOT NULL,
    "marketing" BOOLEAN NOT NULL,
    "gpc" BOOLEAN NOT NULL DEFAULT false,
    "method" TEXT NOT NULL,
    "userId" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentRecord_consentId_createdAt_idx" ON "ConsentRecord"("consentId", "createdAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_userId_createdAt_idx" ON "ConsentRecord"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

