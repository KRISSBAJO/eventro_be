-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketTypeId" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "token" TEXT NOT NULL,
    "clientIp" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventMessage" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ticketTypeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "eventDateId" TEXT,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "emailed" INTEGER NOT NULL DEFAULT 0,
    "emailFailed" INTEGER NOT NULL DEFAULT 0,
    "pushed" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventMessageOptOut" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventMessageOptOut_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_token_key" ON "WaitlistEntry"("token");

-- CreateIndex
CREATE INDEX "WaitlistEntry_eventId_notifiedAt_idx" ON "WaitlistEntry"("eventId", "notifiedAt");

-- CreateIndex
CREATE INDEX "WaitlistEntry_clientIp_createdAt_idx" ON "WaitlistEntry"("clientIp", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_eventId_ticketTypeId_email_key" ON "WaitlistEntry"("eventId", "ticketTypeId", "email");

-- CreateIndex
CREATE INDEX "EventMessage_eventId_createdAt_idx" ON "EventMessage"("eventId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventMessageOptOut_eventId_email_key" ON "EventMessageOptOut"("eventId", "email");

-- AddForeignKey
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMessage" ADD CONSTRAINT "EventMessage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventMessageOptOut" ADD CONSTRAINT "EventMessageOptOut_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

