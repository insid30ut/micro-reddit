-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "WalletProvider" AS ENUM ('yours', 'handcash', 'mock');

-- CreateEnum
CREATE TYPE "CommunityStatus" AS ENUM ('PENDING_MINT', 'ACTIVE', 'PAYOUT_UNAVAILABLE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConfirmationStatus" AS ENUM ('UNCONFIRMED', 'CONFIRMED', 'ORPHANED');

-- CreateEnum
CREATE TYPE "MintStatus" AS ENUM ('PENDING', 'MINTED', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'AWAITING_WALLET', 'SUBMITTED', 'OBSERVED', 'CONFIRMED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RecipientType" AS ENUM ('OWNER', 'PLATFORM');

-- CreateEnum
CREATE TYPE "PaidActivityStatus" AS ENUM ('PENDING_CONFIRMATION', 'AUTHORIZED', 'REVOKED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "WalletProvider" NOT NULL,
    "identityKey" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "currentPayoutScript" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAuthenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "artworkUrl" TEXT,
    "status" "CommunityStatus" NOT NULL DEFAULT 'PENDING_MINT',
    "originalCreatorId" TEXT NOT NULL,
    "nftId" TEXT,
    "currentOwnerScript" TEXT,
    "currentOwnerWalletConnectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_nfts" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT '1sat',
    "originTxid" TEXT NOT NULL,
    "originVout" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "currentTxid" TEXT NOT NULL,
    "currentVout" INTEGER NOT NULL,
    "currentOwnerScript" TEXT NOT NULL,
    "rawOutputScript" TEXT,
    "scriptType" TEXT NOT NULL DEFAULT 'P2PKH',
    "isPayoutRoutable" BOOLEAN NOT NULL DEFAULT true,
    "lastVerifiedBlockHeight" INTEGER,
    "lastVerifiedAt" TIMESTAMP(3),
    "confirmationStatus" "ConfirmationStatus" NOT NULL DEFAULT 'UNCONFIRMED',
    "mintStatus" "MintStatus" NOT NULL DEFAULT 'PENDING',
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_nfts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ownership_events" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "nftId" TEXT NOT NULL,
    "previousOwnerScript" TEXT,
    "newOwnerScript" TEXT NOT NULL,
    "previousOutpoint" TEXT,
    "newOutpoint" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "blockHeight" INTEGER,
    "confirmationStatus" "ConfirmationStatus" NOT NULL DEFAULT 'UNCONFIRMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ownership_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_policies" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "ownerShareBps" INTEGER NOT NULL DEFAULT 7000,
    "platformShareBps" INTEGER NOT NULL DEFAULT 3000,
    "version" INTEGER NOT NULL DEFAULT 1,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL DEFAULT 'SUBMIT_PAID_ACTIVITY',
    "totalSatoshis" INTEGER NOT NULL,
    "ownerSatoshis" INTEGER NOT NULL,
    "platformSatoshis" INTEGER NOT NULL,
    "ownerPayoutScript" TEXT NOT NULL,
    "platformPayoutScript" TEXT NOT NULL,
    "nftOrigin" TEXT NOT NULL,
    "ownerOutpointSnapshot" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'SUBMITTED',
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "verificationBlockHeight" INTEGER,
    "verifiedAt" TIMESTAMP(3),
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "recipientType" "RecipientType" NOT NULL,
    "recipientScript" TEXT NOT NULL,
    "amountSatoshis" INTEGER NOT NULL,
    "outputIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paid_activities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "activityType" TEXT NOT NULL DEFAULT 'SUBMIT_PAID_ACTIVITY',
    "paymentId" TEXT NOT NULL,
    "status" "PaidActivityStatus" NOT NULL DEFAULT 'AUTHORIZED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paid_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "wallet_connections_currentPayoutScript_idx" ON "wallet_connections"("currentPayoutScript");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_connections_provider_identityKey_key" ON "wallet_connections"("provider", "identityKey");

-- CreateIndex
CREATE UNIQUE INDEX "communities_slug_key" ON "communities"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "communities_nftId_key" ON "communities"("nftId");

-- CreateIndex
CREATE INDEX "communities_currentOwnerScript_idx" ON "communities"("currentOwnerScript");

-- CreateIndex
CREATE UNIQUE INDEX "community_nfts_communityId_key" ON "community_nfts"("communityId");

-- CreateIndex
CREATE UNIQUE INDEX "community_nfts_origin_key" ON "community_nfts"("origin");

-- CreateIndex
CREATE INDEX "community_nfts_currentOwnerScript_idx" ON "community_nfts"("currentOwnerScript");

-- CreateIndex
CREATE UNIQUE INDEX "community_nfts_originTxid_originVout_key" ON "community_nfts"("originTxid", "originVout");

-- CreateIndex
CREATE INDEX "ownership_events_communityId_createdAt_idx" ON "ownership_events"("communityId", "createdAt");

-- CreateIndex
CREATE INDEX "ownership_events_nftId_createdAt_idx" ON "ownership_events"("nftId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_policies_communityId_version_key" ON "revenue_policies"("communityId", "version");

-- CreateIndex
CREATE INDEX "payment_intents_communityId_status_idx" ON "payment_intents"("communityId", "status");

-- CreateIndex
CREATE INDEX "payment_intents_userId_createdAt_idx" ON "payment_intents"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_paymentIntentId_key" ON "payments"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_transactionId_key" ON "payments"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocations_paymentId_outputIndex_key" ON "payment_allocations"("paymentId", "outputIndex");

-- CreateIndex
CREATE UNIQUE INDEX "paid_activities_paymentId_key" ON "paid_activities"("paymentId");

-- CreateIndex
CREATE INDEX "paid_activities_communityId_createdAt_idx" ON "paid_activities"("communityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_events_entityType_entityId_idx" ON "audit_events"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_events_eventType_createdAt_idx" ON "audit_events"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "wallet_connections" ADD CONSTRAINT "wallet_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communities" ADD CONSTRAINT "communities_originalCreatorId_fkey" FOREIGN KEY ("originalCreatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communities" ADD CONSTRAINT "communities_currentOwnerWalletConnectionId_fkey" FOREIGN KEY ("currentOwnerWalletConnectionId") REFERENCES "wallet_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_nfts" ADD CONSTRAINT "community_nfts_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownership_events" ADD CONSTRAINT "ownership_events_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ownership_events" ADD CONSTRAINT "ownership_events_nftId_fkey" FOREIGN KEY ("nftId") REFERENCES "community_nfts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_policies" ADD CONSTRAINT "revenue_policies_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId") REFERENCES "payment_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paid_activities" ADD CONSTRAINT "paid_activities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paid_activities" ADD CONSTRAINT "paid_activities_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paid_activities" ADD CONSTRAINT "paid_activities_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddCheckConstraints (Domain & Revenue Policy Invariants)
ALTER TABLE "revenue_policies"
  ADD CONSTRAINT "revenue_policies_owner_share_min_check" CHECK ("ownerShareBps" >= 5000),
  ADD CONSTRAINT "revenue_policies_total_bps_check" CHECK ("ownerShareBps" + "platformShareBps" = 10000);

ALTER TABLE "payment_intents"
  ADD CONSTRAINT "payment_intents_amounts_check" CHECK (
    "totalSatoshis" > 0
    AND "ownerSatoshis" > 0
    AND "platformSatoshis" > 0
    AND "ownerSatoshis" + "platformSatoshis" = "totalSatoshis"
  );

ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_positive_amount_check" CHECK (
    "amountSatoshis" > 0
    AND "outputIndex" >= 0
  );


