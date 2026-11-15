import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '@/generated/prisma/client';
import { MockWalletAdapter } from '../../src/adapters/wallets/mock.adapter.js';
import { WalletAuthError, WalletAuthService } from '../../src/lib/auth/auth-service.js';

/**
 * Real-PostgreSQL integration tests (true separate connections, true concurrency).
 * Runs ONLY when TEST_DATABASE_URL points to a disposable database that already has all
 * Prisma migrations applied (`prisma migrate deploy`). Otherwise the suite is skipped
 * (and reported as skipped, never as passed).
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;
const SECRET = 'integration-test-session-secret-minimum-32-chars';
const DOMAIN = 'localhost:3000';

function openClient(): { prisma: PrismaClient; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 10 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return { prisma, pool };
}

async function login(
  service: WalletAuthService,
  persona: 'alice' | 'bob' | 'payer',
  currentSessionToken?: string
) {
  const adapter = new MockWalletAdapter({ persona });
  const conn = await adapter.connect();
  const challenge = await service.issueChallenge({
    provider: 'mock',
    domain: DOMAIN,
    ...(currentSessionToken ? { currentSessionToken } : {}),
  });
  const sig = await adapter.signChallenge(challenge.challengeText);
  return service.verifyChallengeAndAuthenticate({
    challengeId: challenge.id,
    provider: 'mock',
    publicKey: sig.publicKey,
    identityKey: conn.identityKey,
    signature: sig.signature,
    ...(sig.keyID ? { keyID: sig.keyID } : {}),
    ...(conn.payoutScript ? { payoutScript: conn.payoutScript } : {}),
    ...(conn.destinationProof
      ? { destinationProof: conn.destinationProof }
      : {}),
    expectedDomain: DOMAIN,
    ...(currentSessionToken ? { currentSessionToken } : {}),
  });
}

suite('PostgreSQL authentication lifecycle (real PostgreSQL via pg.Pool)', () => {
  let handle: { prisma: PrismaClient; pool: pg.Pool };

  beforeAll(async () => {
    handle = openClient();
    const svc = new WalletAuthService({ prisma: handle.prisma, sessionSecret: SECRET });
    await svc.clear();
  });

  afterAll(async () => {
    await handle.prisma.$disconnect();
    await handle.pool.end();
  });

  it('runs challenge -> verify -> persistent session -> restart -> revoke', async () => {
    const svcA = new WalletAuthService({ prisma: handle.prisma, sessionSecret: SECRET });
    const result = await login(svcA, 'alice');
    expect(result.user.id).toBeTruthy();

    const dbChallenge = await handle.prisma.authChallenge.findFirst({
      where: { usedAt: { not: null } },
    });
    expect(dbChallenge).not.toBeNull();

    // "Restart the application": discard client + pool + service, open brand new ones.
    await handle.prisma.$disconnect();
    await handle.pool.end();
    handle = openClient();
    const svcRestarted = new WalletAuthService({
      prisma: handle.prisma,
      sessionSecret: SECRET,
    });

    const ctx = await svcRestarted.getSessionContext(result.sessionToken);
    expect(ctx.user.id).toBe(result.user.id);

    await svcRestarted.logout(result.sessionToken);
    await expect(svcRestarted.getSessionContext(result.sessionToken)).rejects.toThrow(
      /revoked/i
    );
    const row = await handle.prisma.authSession.findUnique({
      where: { sessionId: result.session.sessionId },
    });
    expect(row?.revokedAt).toBeInstanceOf(Date);
  });

  it('rejects a reused challenge', async () => {
    const svc = new WalletAuthService({ prisma: handle.prisma, sessionSecret: SECRET });
    const adapter = new MockWalletAdapter({ persona: 'bob', network: 'test' });
    const conn = await adapter.connect();
    const challenge = await svc.issueChallenge({ provider: 'mock', domain: DOMAIN });
    const sig = await adapter.signChallenge(challenge.challengeText);
    const payload = {
      challengeId: challenge.id,
      provider: 'mock' as const,
      publicKey: sig.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      expectedDomain: DOMAIN,
    };
    await svc.verifyChallengeAndAuthenticate(payload);
    await expect(svc.verifyChallengeAndAuthenticate(payload)).rejects.toMatchObject({
      code: 'CHALLENGE_REUSED',
    });
  });

  it('lets exactly one of 8 concurrent verifications (separate services/connections) consume a challenge', async () => {
    const adapter = new MockWalletAdapter({ persona: 'payer', network: 'test' });
    const conn = await adapter.connect();
    const issuer = new WalletAuthService({ prisma: handle.prisma, sessionSecret: SECRET });
    const challenge = await issuer.issueChallenge({ provider: 'mock', domain: DOMAIN });
    const sig = await adapter.signChallenge(challenge.challengeText);
    const payload = {
      challengeId: challenge.id,
      provider: 'mock' as const,
      publicKey: sig.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      expectedDomain: DOMAIN,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        new WalletAuthService({
          prisma: handle.prisma,
          sessionSecret: SECRET,
        }).verifyChallengeAndAuthenticate(payload)
      )
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(7);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(WalletAuthError);
      expect((f.reason as WalletAuthError).code).toBe('CHALLENGE_REUSED');
    }
    // Only a single user/wallet exists for that identity.
    const wallets = await handle.prisma.walletConnection.count({
      where: { identityKey: conn.identityKey },
    });
    expect(wallets).toBe(1);
  });

  it('links a second wallet to one account and rejects linking a wallet owned by another account', async () => {
    const svc = new WalletAuthService({ prisma: handle.prisma, sessionSecret: SECRET });
    await svc.clear();

    const alice = await login(svc, 'alice');
    // Second (different) wallet identity linked to Alice's account
    const linked = await login(svc, 'bob', alice.sessionToken);
    expect(linked.linkedExistingAccount).toBe(true);
    expect(linked.user.id).toBe(alice.user.id);
    expect(linked.wallets).toHaveLength(2);

    // Charlie (payer) owns a separate account; trying to claim Alice's linked Bob wallet fails.
    const charlie = await login(svc, 'payer');
    await expect(login(svc, 'bob', charlie.sessionToken)).rejects.toMatchObject({
      code: 'UNAUTHORIZED_WALLET_LINK',
      statusCode: 409,
    });
  });
});
