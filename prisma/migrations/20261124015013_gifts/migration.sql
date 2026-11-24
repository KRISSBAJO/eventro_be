-- CreateTable
CREATE TABLE "Gift" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "hidePrice" BOOLEAN NOT NULL DEFAULT true,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Gift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Gift_orderId_key" ON "Gift"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Gift_token_key" ON "Gift"("token");

-- CreateIndex
CREATE INDEX "Gift_sentAt_sendAt_idx" ON "Gift"("sentAt", "sendAt");

-- CreateIndex
CREATE INDEX "Gift_recipientEmail_idx" ON "Gift"("recipientEmail");

-- AddForeignKey
ALTER TABLE "Gift" ADD CONSTRAINT "Gift_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
