import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOrderedMigrationSqlFiles } from '../helpers/pglite-prisma';

const ALICE_SCRIPT = '76a914111111111111111111111111111111111111111188ac';
const BOB_UNREGISTERED_SCRIPT =
  '76a914222222222222222222222222222222222222222288ac';
const PLATFORM_SCRIPT = '76a914000000000000000000000000000000000000000188ac';
const GENESIS_TXID =
  'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const GENESIS_ORIGIN = `${GENESIS_TXID}_0`;
const TRANSFER_TXID =
  'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const TRANSFER_OUTPOINT = `${TRANSFER_TXID}_0`;

describe('PostgreSQL Migration & Database Schema Constraints', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    for (const migrationSql of loadOrderedMigrationSqlFiles()) {
      await db.exec(migrationSql);
    }
  });

  afterAll(async () => {
    await db.close();
  });

  it('applies the initial migration and allows NFT ownership by on-chain script without a registered WalletConnection', async () => {
    // Create Alice (original creator)
    await db.query(
      `INSERT INTO "users" ("id", "username", "displayName", "updatedAt")
       VALUES ('user_alice', 'alice', 'Alice', NOW()),
              ('user_payer', 'payer', 'Payer', NOW());`
    );

    await db.query(
      `INSERT INTO "wallet_connections" ("id", "userId", "provider", "identityKey", "publicKey", "currentPayoutScript")
       VALUES ('wc_alice', 'user_alice', 'yours', '02aliceidentity', '02alicepub', $1);`,
      [ALICE_SCRIPT]
    );

    // Create community initially owned by Alice
    await db.query(
      `INSERT INTO "communities" (
         "id", "name", "slug", "description", "status",
         "originalCreatorId", "nftId", "currentOwnerScript", "currentOwnerWalletConnectionId", "updatedAt"
       ) VALUES (
         'comm_tech', 'Technology & Programming', 'technology-programming',
         'Tech community', 'ACTIVE', 'user_alice', 'nft_1', $1, 'wc_alice', NOW()
       );`,
      [ALICE_SCRIPT]
    );

    await db.query(
      `INSERT INTO "community_nfts" (
         "id", "communityId", "protocol", "originTxid", "originVout", "origin",
         "currentTxid", "currentVout", "currentOwnerScript", "confirmationStatus", "mintStatus", "updatedAt"
       ) VALUES (
         'nft_1', 'comm_tech', '1sat', $1, 0, $2, $1, 0, $3, 'CONFIRMED', 'VERIFIED', NOW()
       );`,
      [GENESIS_TXID, GENESIS_ORIGIN, ALICE_SCRIPT]
    );

    // Record PaymentIntent #1 while Alice owns the NFT
    await db.query(
      `INSERT INTO "payment_intents" (
         "id", "userId", "communityId", "actionType", "totalSatoshis",
         "ownerSatoshis", "platformSatoshis", "ownerPayoutScript", "platformPayoutScript",
         "nftOrigin", "ownerOutpointSnapshot", "policyVersion", "status", "expiresAt"
       ) VALUES (
         'intent_1', 'user_payer', 'comm_tech', 'SUBMIT_PAID_ACTIVITY',
         10000, 7000, 3000, $1, $2, $3, $3, 1, 'CREATED', NOW() + INTERVAL '2 minutes'
       );`,
      [ALICE_SCRIPT, PLATFORM_SCRIPT, GENESIS_ORIGIN]
    );

    // Transfer NFT on-chain to Bob, who has NEVER registered on the website (currentOwnerWalletConnectionId = NULL)
    await db.query(
      `UPDATE "communities"
       SET "currentOwnerScript" = $1,
           "currentOwnerWalletConnectionId" = NULL,
           "updatedAt" = NOW()
       WHERE "id" = 'comm_tech';`,
      [BOB_UNREGISTERED_SCRIPT]
    );

    await db.query(
      `UPDATE "community_nfts"
       SET "currentTxid" = $1,
           "currentVout" = 0,
           "currentOwnerScript" = $2,
           "updatedAt" = NOW()
       WHERE "id" = 'nft_1';`,
      [TRANSFER_TXID, BOB_UNREGISTERED_SCRIPT]
    );

    // Verify community is valid with NULL currentOwnerWalletConnectionId and Bob's locking script
    const commRes = await db.query<{
      currentOwnerScript: string;
      currentOwnerWalletConnectionId: string | null;
    }>(
      `SELECT "currentOwnerScript", "currentOwnerWalletConnectionId"
       FROM "communities" WHERE "id" = 'comm_tech';`
    );
    expect(commRes.rows[0]?.currentOwnerScript).toBe(BOB_UNREGISTERED_SCRIPT);
    expect(commRes.rows[0]?.currentOwnerWalletConnectionId).toBeNull();

    // Verify PaymentIntent #1 still retains Alice's original ownership snapshot
    const intent1Res = await db.query<{
      ownerPayoutScript: string;
      ownerOutpointSnapshot: string;
    }>(
      `SELECT "ownerPayoutScript", "ownerOutpointSnapshot"
       FROM "payment_intents" WHERE "id" = 'intent_1';`
    );
    expect(intent1Res.rows[0]?.ownerPayoutScript).toBe(ALICE_SCRIPT);
    expect(intent1Res.rows[0]?.ownerOutpointSnapshot).toBe(GENESIS_ORIGIN);

    // Verify a subsequent PaymentIntent #2 captures Bob's new outpoint and script
    await db.query(
      `INSERT INTO "payment_intents" (
         "id", "userId", "communityId", "actionType", "totalSatoshis",
         "ownerSatoshis", "platformSatoshis", "ownerPayoutScript", "platformPayoutScript",
         "nftOrigin", "ownerOutpointSnapshot", "policyVersion", "status", "expiresAt"
       ) VALUES (
         'intent_2', 'user_payer', 'comm_tech', 'SUBMIT_PAID_ACTIVITY',
         10000, 7000, 3000, $1, $2, $3, $4, 1, 'CREATED', NOW() + INTERVAL '2 minutes'
       );`,
      [BOB_UNREGISTERED_SCRIPT, PLATFORM_SCRIPT, GENESIS_ORIGIN, TRANSFER_OUTPOINT]
    );

    const intent2Res = await db.query<{
      ownerPayoutScript: string;
      ownerOutpointSnapshot: string;
    }>(
      `SELECT "ownerPayoutScript", "ownerOutpointSnapshot"
       FROM "payment_intents" WHERE "id" = 'intent_2';`
    );
    expect(intent2Res.rows[0]?.ownerPayoutScript).toBe(BOB_UNREGISTERED_SCRIPT);
    expect(intent2Res.rows[0]?.ownerOutpointSnapshot).toBe(TRANSFER_OUTPOINT);
  });

  it('enforces RevenuePolicy CHECK constraints (ownerShareBps >= 5000 and sum == 10000)', async () => {
    // Valid 70/30 policy succeeds
    await expect(
      db.query(
        `INSERT INTO "revenue_policies" ("id", "communityId", "ownerShareBps", "platformShareBps", "version")
         VALUES ('rp_valid', 'comm_tech', 7000, 3000, 1);`
      )
    ).resolves.toBeDefined();

    // Invalid policy (< 5000 bps for owner) fails SQL CHECK constraint
    await expect(
      db.query(
        `INSERT INTO "revenue_policies" ("id", "communityId", "ownerShareBps", "platformShareBps", "version")
         VALUES ('rp_low_owner', 'comm_tech', 4999, 5001, 2);`
      )
    ).rejects.toThrow();

    // Invalid policy (sum != 10000) fails SQL CHECK constraint
    await expect(
      db.query(
        `INSERT INTO "revenue_policies" ("id", "communityId", "ownerShareBps", "platformShareBps", "version")
         VALUES ('rp_bad_sum', 'comm_tech', 7000, 2000, 3);`
      )
    ).rejects.toThrow();
  });

  it('enforces unique constraints on NFT origin, duplicate payments, and payment intent amounts', async () => {
    // Reject PaymentIntent where ownerSatoshis + platformSatoshis != totalSatoshis
    await expect(
      db.query(
        `INSERT INTO "payment_intents" (
           "id", "userId", "communityId", "actionType", "totalSatoshis",
           "ownerSatoshis", "platformSatoshis", "ownerPayoutScript", "platformPayoutScript",
           "nftOrigin", "ownerOutpointSnapshot", "policyVersion", "status", "expiresAt"
         ) VALUES (
           'intent_bad_math', 'user_payer', 'comm_tech', 'SUBMIT_PAID_ACTIVITY',
           10000, 6000, 3000, $1, $2, $3, $3, 1, 'CREATED', NOW() + INTERVAL '2 minutes'
         );`,
        [ALICE_SCRIPT, PLATFORM_SCRIPT, GENESIS_ORIGIN]
      )
    ).rejects.toThrow();

    // Record a valid payment for intent_1
    await db.query(
      `INSERT INTO "payments" ("id", "paymentIntentId", "transactionId", "status", "confirmations")
       VALUES ('pay_1', 'intent_1', 'tx_payment_001', 'CONFIRMED', 1);`
    );

    // Reject reusing the same transactionId on another PaymentIntent (duplicate tx prevention)
    await expect(
      db.query(
        `INSERT INTO "payments" ("id", "paymentIntentId", "transactionId", "status", "confirmations")
         VALUES ('pay_dup_tx', 'intent_2', 'tx_payment_001', 'CONFIRMED', 1);`
      )
    ).rejects.toThrow();

    // Reject a second Payment record for the same PaymentIntent
    await expect(
      db.query(
        `INSERT INTO "payments" ("id", "paymentIntentId", "transactionId", "status", "confirmations")
         VALUES ('pay_dup_intent', 'intent_1', 'tx_payment_002', 'CONFIRMED', 1);`
      )
    ).rejects.toThrow();
  });

  it('enforces fail-closed security defaults on CommunityNFT, PaidActivity, and unique WalletConnection identities', async () => {
    // 1. Regression check: inspecting CommunityNFT defaults from previous insert (`nft_1`)
    const nftDefaults = await db.query<{
      scriptType: string;
      isPayoutRoutable: boolean;
    }>(
      `SELECT "scriptType", "isPayoutRoutable" FROM "community_nfts" WHERE "id" = 'nft_1';`
    );
    expect(nftDefaults.rows[0]?.scriptType).toBe('UNVERIFIED');
    expect(nftDefaults.rows[0]?.isPayoutRoutable).toBe(false);

    // 2. Regression check: PaidActivity defaults to PENDING_CONFIRMATION (never AUTHORIZED)
    await db.query(
      `INSERT INTO "paid_activities" ("id", "userId", "communityId", "activityType", "paymentId")
       VALUES ('pa_default_check', 'user_payer', 'comm_tech', 'SUBMIT_PAID_ACTIVITY', 'pay_1');`
    );
    const paRes = await db.query<{ status: string }>(
      `SELECT "status" FROM "paid_activities" WHERE "id" = 'pa_default_check';`
    );
    expect(paRes.rows[0]?.status).toBe('PENDING_CONFIRMATION');

    // 3. Regression check: Duplicate (provider, identityKey) wallet identity is rejected at DB level
    await expect(
      db.query(
        `INSERT INTO "wallet_connections" ("id", "userId", "provider", "identityKey", "publicKey", "currentPayoutScript")
         VALUES ('wc_dup_alice', 'user_payer', 'yours', '02aliceidentity', '02alicepub', $1);`,
        [BOB_UNREGISTERED_SCRIPT]
      )
    ).rejects.toThrow();
  });

  it('constructs all 13 Prisma tables, columns, indexes, RLS protections, and blocks non-P2PKH payout routing at the DB level', async () => {
    const tablesRes = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY c.relname ASC;`
    );

    const expectedTables = [
      'audit_events',
      'auth_challenges',
      'auth_sessions',
      'communities',
      'community_nfts',
      'ownership_events',
      'paid_activities',
      'payment_allocations',
      'payment_intents',
      'payments',
      'revenue_policies',
      'users',
      'wallet_connections',
    ];

    expect(tablesRes.rows.map((r) => r.tablename)).toEqual(expectedTables);
    for (const row of tablesRes.rows) {
      expect(row.rowsecurity).toBe(true);
    }

    // Verify WalletConnection migration columns exist with safe defaults
    const wcColsRes = await db.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'wallet_connections'
         AND column_name IN ('network', 'connected', 'updatedAt')
       ORDER BY column_name ASC;`
    );
    expect(wcColsRes.rows.map((r) => r.column_name)).toEqual([
      'connected',
      'network',
      'updatedAt',
    ]);
    expect(wcColsRes.rows.find((r) => r.column_name === 'network')?.column_default).toContain('test');
    expect(wcColsRes.rows.find((r) => r.column_name === 'connected')?.column_default).toBe('true');

    // Verify AuditEvent.actorUserId column & index exist
    const auditColRes = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'audit_events' AND column_name = 'actorUserId';`
    );
    expect(auditColRes.rows).toHaveLength(1);

    const auditIdxRes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'audit_events' AND indexname = 'audit_events_actorUserId_idx';`
    );
    expect(auditIdxRes.rows).toHaveLength(1);

    // Reject marking an UNVERIFIED, ORDLOCK, NON_STANDARD, or EMPTY CommunityNFT as payout-routable
    await db.query(
      `INSERT INTO "communities" (
         "id", "name", "slug", "description", "status",
         "originalCreatorId", "updatedAt"
       ) VALUES (
         'comm_unroutable_check', 'Unroutable NFT Community', 'unroutable-nft-community',
         'Constraint test community', 'PENDING_MINT', 'user_alice', NOW()
       );`
    );

    for (const [idx, badScriptType] of [
      'UNVERIFIED',
      'ORDLOCK',
      'NON_STANDARD',
      'EMPTY',
    ].entries()) {
      const badTxid = `${idx + 1}`.repeat(64);
      await expect(
        db.query(
          `INSERT INTO "community_nfts" (
             "id", "communityId", "protocol", "originTxid", "originVout", "origin",
             "currentTxid", "currentVout", "currentOwnerScript", "scriptType", "isPayoutRoutable", "updatedAt"
           ) VALUES (
             $1, 'comm_unroutable_check', '1sat', $2, 0, $3, $2, 0, '51', $4, true, NOW()
           );`,
          [
            `nft_bad_${badScriptType.toLowerCase()}`,
            badTxid,
            `${badTxid}_0`,
            badScriptType,
          ]
        )
      ).rejects.toThrow(/payout_routable_requires_p2pkh_check/i);
    }

    // Verified P2PKH with isPayoutRoutable = true succeeds, and cannot later be downgraded without setting isPayoutRoutable = false
    const validTxid = 'f'.repeat(64);
    await expect(
      db.query(
        `INSERT INTO "community_nfts" (
           "id", "communityId", "protocol", "originTxid", "originVout", "origin",
           "currentTxid", "currentVout", "currentOwnerScript", "scriptType", "isPayoutRoutable", "updatedAt"
         ) VALUES (
           'nft_valid_p2pkh', 'comm_unroutable_check', '1sat',
           $1, 0, $2, $1, 0, $3, 'P2PKH', true, NOW()
         );`,
        [validTxid, `${validTxid}_0`, ALICE_SCRIPT]
      )
    ).resolves.toBeDefined();

    await expect(
      db.query(
        `UPDATE "community_nfts" SET "scriptType" = 'NON_STANDARD' WHERE "id" = 'nft_valid_p2pkh';`
      )
    ).rejects.toThrow(/payout_routable_requires_p2pkh_check/i);
  });
});
