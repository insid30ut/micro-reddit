-- AlterTable: Enforce fail-closed security defaults on CommunityNFT and PaidActivity
ALTER TABLE "community_nfts"
    ALTER COLUMN "scriptType" SET DEFAULT 'UNVERIFIED',
    ALTER COLUMN "isPayoutRoutable" SET DEFAULT false;

ALTER TABLE "paid_activities"
    ALTER COLUMN "status" SET DEFAULT 'PENDING_CONFIRMATION';

-- AlterTable: Add network, connected state, and updatedAt tracking on WalletConnection
ALTER TABLE "wallet_connections"
    ADD COLUMN IF NOT EXISTS "network" TEXT NOT NULL DEFAULT 'test',
    ADD COLUMN IF NOT EXISTS "connected" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: Add actorUserId to AuditEvent for authentication & security event indexing
ALTER TABLE "audit_events"
    ADD COLUMN IF NOT EXISTS "actorUserId" TEXT;

-- CreateTable: Persistent domain-bound, single-use authentication challenges
CREATE TABLE IF NOT EXISTS "auth_challenges" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "provider" "WalletProvider" NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT,
    "challengeText" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Persistent server-side sessions with revocation support
CREATE TABLE IF NOT EXISTS "auth_sessions" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeWalletConnectionId" TEXT NOT NULL,
    "provider" "WalletProvider" NOT NULL,
    "identityKey" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("sessionId")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "auth_challenges_nonce_key" ON "auth_challenges"("nonce");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "auth_challenges_userId_idx" ON "auth_challenges"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "auth_challenges_expiresAt_idx" ON "auth_challenges"("expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "auth_sessions_userId_idx" ON "auth_sessions"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "auth_sessions_activeWalletConnectionId_idx" ON "auth_sessions"("activeWalletConnectionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "auth_sessions_expiresAt_idx" ON "auth_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_events_actorUserId_idx" ON "audit_events"("actorUserId");

-- AddForeignKey
ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_userId_fkey";
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_activeWalletConnectionId_fkey";
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_activeWalletConnectionId_fkey" FOREIGN KEY ("activeWalletConnectionId") REFERENCES "wallet_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EnableRowLevelSecurity
ALTER TABLE "auth_challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_sessions" ENABLE ROW LEVEL SECURITY;
