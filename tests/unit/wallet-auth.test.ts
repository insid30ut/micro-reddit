import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BSM, PrivateKey, ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk';
import type { PrismaClient } from '@/generated/prisma/client';
import { POST as challengePostRoute } from '@/app/api/auth/challenge/route';
import { POST as verifyPostRoute } from '@/app/api/auth/verify/route';
import { POST as walletConnectPostRoute } from '@/app/api/wallets/connect/route';
import { createTestPGlitePrisma } from '../helpers/pglite-prisma';
import { MockWalletAdapter } from '../../src/adapters/wallets/mock.adapter.js';
import {
  isYoursCompatibleVersion,
  YoursWalletAdapter,
  type YoursInjectedExtension,
} from '../../src/adapters/wallets/yours.adapter.js';
import {
  HandCashWalletAdapter,
  HANDCASH_FALLBACK_BRIDGE_URL,
  HANDCASH_PRIMARY_BRIDGE_URL,
} from '../../src/adapters/wallets/handcash.adapter.js';
import {
  UnsupportedWalletOperationError,
  WalletConnectionError,
} from '../../src/adapters/wallets/wallet-adapter.js';
import {
  createExplicitWalletAdapter,
  discoverAvailableWallets,
} from '../../src/adapters/wallets/provider-registry.js';
import {
  WalletAuthError,
  WalletAuthService,
} from '../../src/lib/auth/auth-service.js';
import {
  DESTINATION_BRC100_PROTOCOL_ID,
  deriveP2PKHScriptFromPublicKey,
  formatDestinationOwnershipProofMessage,
  verifyDestinationOwnershipProof,
} from '../../src/lib/auth/crypto-verify.js';
import { resolveRequestDomain } from '../../src/lib/auth/http-helpers.js';
import { SessionStore } from '../../src/lib/auth/session-service.js';
import { WalletConnectionStateManager } from '../../src/lib/auth/wallet-state.js';

/**
 * Helper to build a simulated BRC-100 `WalletInterface` backed by `@bsv/sdk` `ProtoWallet`
 * with a specific vendor version string (e.g., "yours-2.4.0" or "handcash-1.2.0").
 */
function createBRC100WalletSubstrate(params: {
  seedLabel: string;
  version: string;
  network?: 'mainnet' | 'testnet';
}): {
  walletClient: WalletInterface;
  privateKey: PrivateKey;
  identityKeyHex: string;
} {
  const hashBytes = Utils.toArray(params.seedLabel, 'utf8');
  const padded = new Array<number>(32).fill(0);
  for (let i = 0; i < 32; i++) {
    padded[i] = (hashBytes[i % hashBytes.length] ?? 1) ^ ((i + 1) * 29);
  }
  const privateKey = new PrivateKey(padded);
  const proto = new ProtoWallet(privateKey);
  const identityKeyHex = privateKey.toPublicKey().toString().toLowerCase();

  const walletClient = {
    async isAuthenticated() {
      return { authenticated: true };
    },
    async waitForAuthentication() {
      return { authenticated: true };
    },
    async getNetwork() {
      return { network: params.network ?? 'testnet' };
    },
    async getVersion() {
      return { version: params.version };
    },
    async getPublicKey(args: Parameters<ProtoWallet['getPublicKey']>[0]) {
      return proto.getPublicKey(args);
    },
    async createSignature(args: Parameters<ProtoWallet['createSignature']>[0]) {
      return proto.createSignature(args);
    },
  } as unknown as WalletInterface;

  return {
    walletClient,
    privateKey,
    identityKeyHex,
  };
}

/**
 * Helper to build a simulated `window.yours` injected extension object
 * that signs messages using genuine Bitcoin Signed Message (BSM) secp256k1 signatures.
 */
function createYoursInjectedExtension(seedLabel: string): {
  extension: YoursInjectedExtension;
  privateKey: PrivateKey;
  identityKeyHex: string;
} {
  const hashBytes = Utils.toArray(seedLabel, 'utf8');
  const padded = new Array<number>(32).fill(0);
  for (let i = 0; i < 32; i++) {
    padded[i] = (hashBytes[i % hashBytes.length] ?? 1) ^ ((i + 1) * 41);
  }
  const privateKey = new PrivateKey(padded);
  const pubKey = privateKey.toPublicKey();
  const identityKeyHex = pubKey.toString().toLowerCase();

  const extension: YoursInjectedExtension = {
    isReady: true,
    async connect() {
      return identityKeyHex;
    },
    async disconnect() {
      return;
    },
    async getPubKeys() {
      return {
        identityPubKey: identityKeyHex,
        bsvPubKey: identityKeyHex,
        ordPubKey: identityKeyHex,
      };
    },
    async getAddresses() {
      return {
        bsvAddress: pubKey.toAddress(),
        identityAddress: pubKey.toAddress(),
      };
    },
    async getNetwork() {
      return 'testnet';
    },
    async signMessage({ message }) {
      const msgBytes = Utils.toArray(message, 'utf8');
      const bsmBase64 = BSM.sign(msgBytes, privateKey, 'base64') as string;
      return {
        signedMessage: {
          message,
          sig: bsmBase64,
          address: pubKey.toAddress(),
        },
      };
    },
  };

  return {
    extension,
    privateKey,
    identityKeyHex,
  };
}

describe('Phase 2 — Persistent Wallet Authentication & Security Audit', () => {
  const appDomain = 'localhost:3000';
  const testSessionSecret = 'unit-test-session-secret-minimum-32-chars-2026';

  let dbHandle: Awaited<ReturnType<typeof createTestPGlitePrisma>>;
  let prisma: PrismaClient;
  let authService: WalletAuthService;

  beforeAll(async () => {
    dbHandle = await createTestPGlitePrisma();
    prisma = dbHandle.prisma;
  });

  afterAll(async () => {
    await dbHandle.close();
  });

  beforeEach(async () => {
    authService = new WalletAuthService({
      prisma,
      sessionSecret: testSessionSecret,
      envSource: { BSV_NETWORK: 'test' },
    });
    await authService.clear();
  });

  it('0. Completes the full MockWalletAdapter authentication lifecycle and state transitions', async () => {
    const stateManager = new WalletConnectionStateManager();
    const observedStates: string[] = [];
    stateManager.subscribe((snap) => {
      observedStates.push(snap.state);
    });

    const identity = await stateManager.connectProvider('mock', {
      mockOptions: {
        persona: 'alice',
        network: 'test',
      },
    });

    expect(identity.provider).toBe('mock');
    expect(identity.identityKey).toMatch(/^(02|03)[0-9a-f]{64}$/);
    expect(identity.payoutScript).toMatch(/^76a914[0-9a-f]{40}88ac$/);

    const challenge = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });

    const authResult = await stateManager.authenticateWithChallenge(
      challenge.challengeText,
      async (signed) =>
        authService.verifyChallengeAndAuthenticate({
          challengeId: challenge.id,
          provider: signed.provider,
          publicKey: signed.publicKey,
          identityKey: signed.identity.identityKey,
          signature: signed.signature,
          ...(signed.keyID ? { keyID: signed.keyID } : {}),
          ...(signed.signatureScheme
            ? { signatureScheme: signed.signatureScheme }
            : {}),
          expectedDomain: appDomain,
        })
    );

    expect(authResult.user.id).toBeTruthy();
    expect(authResult.activeWallet.provider).toBe('mock');
    expect(authResult.cookie.httpOnly).toBe(true);
    expect(observedStates).toEqual([
      'connecting',
      'connected',
      'authenticating',
      'authenticated',
    ]);
  });

  it('1. Succeeds with Yours Wallet authentication (simulated BRC-100 CWI and window.yours BSM extension)', async () => {
    // Path A: Yours BRC-100 CWI substrate (simulated via ProtoWallet)
    const yoursBrc100 = createBRC100WalletSubstrate({
      seedLabel: 'yours-brc100-user',
      version: 'yours-2.5.0',
    });
    const yoursCwiAdapter = new YoursWalletAdapter({
      brc100Wallet: yoursBrc100.walletClient,
    });

    const connA = await yoursCwiAdapter.connect();
    expect(connA.provider).toBe('yours');
    expect(connA.identityKey).toBe(yoursBrc100.identityKeyHex);

    const challengeA = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sigA = await yoursCwiAdapter.signChallenge(challengeA.challengeText);
    expect(sigA.signatureScheme).toBe('brc100');

    const verifiedA = await authService.verifyChallengeAndAuthenticate({
      challengeId: challengeA.id,
      provider: 'yours',
      publicKey: sigA.publicKey,
      identityKey: connA.identityKey,
      signature: sigA.signature,
      ...(sigA.keyID ? { keyID: sigA.keyID } : {}),
      ...(sigA.signatureScheme ? { signatureScheme: sigA.signatureScheme } : {}),
      expectedDomain: appDomain,
    });
    expect(verifiedA.activeWallet.provider).toBe('yours');
    expect(verifiedA.activeWallet.identityKey).toBe(yoursBrc100.identityKeyHex);

    // Path B: Yours injected browser extension (`window.yours.signMessage` BSM simulation)
    const yoursExt = createYoursInjectedExtension('yours-extension-user');
    const yoursExtAdapter = new YoursWalletAdapter({
      injectedExtension: yoursExt.extension,
    });

    const connB = await yoursExtAdapter.connect();
    expect(connB.provider).toBe('yours');
    expect(connB.identityKey).toBe(yoursExt.identityKeyHex);

    const challengeB = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sigB = await yoursExtAdapter.signChallenge(challengeB.challengeText);
    expect(sigB.signatureScheme).toBe('bsm');

    const verifiedB = await authService.verifyChallengeAndAuthenticate({
      challengeId: challengeB.id,
      provider: 'yours',
      publicKey: sigB.publicKey,
      identityKey: connB.identityKey,
      signature: sigB.signature,
      ...(sigB.signatureScheme ? { signatureScheme: sigB.signatureScheme } : {}),
      expectedDomain: appDomain,
    });
    expect(verifiedB.activeWallet.provider).toBe('yours');
    expect(verifiedB.activeWallet.identityKey).toBe(yoursExt.identityKeyHex);
  });

  it('2. Rejects HandCash on the server while HandCash is disabled (adapter code retained)', async () => {
    const handcashSub = createBRC100WalletSubstrate({
      seedLabel: 'handcash-brc100-user',
      version: 'handcash-1.4.2',
    });
    const handcashAdapter = new HandCashWalletAdapter({
      brc100Wallet: handcashSub.walletClient,
    });

    // The retained adapter still works against a BRC-100 substrate...
    const conn = await handcashAdapter.connect();
    expect(conn.provider).toBe('handcash');

    // ...but the server refuses to issue HandCash challenges...
    await expect(
      authService.issueChallenge({ provider: 'handcash', domain: appDomain })
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED', statusCode: 403 });

    // ...and refuses to verify a HandCash login even if a challenge id is supplied.
    const yoursChallenge = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sig = await handcashAdapter.signChallenge(yoursChallenge.challengeText);
    await expect(
      authService.verifyChallengeAndAuthenticate({
        challengeId: yoursChallenge.id,
        provider: 'handcash',
        publicKey: sig.publicKey,
        identityKey: conn.identityKey,
        signature: sig.signature,
        ...(sig.keyID ? { keyID: sig.keyID } : {}),
        ...(sig.signatureScheme ? { signatureScheme: sig.signatureScheme } : {}),
        expectedDomain: appDomain,
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED', statusCode: 403 });

    // The HTTP route surfaces the same 403.
    const res = await challengePostRoute(
      new NextRequest(`http://${appDomain}/api/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: appDomain },
        body: JSON.stringify({ provider: 'handcash' }),
      })
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('PROVIDER_DISABLED');
  });

  it('3. Rejects failed authentication (invalid signature, wrong public key, or domain mismatch)', async () => {
    const aliceAdapter = new MockWalletAdapter({ persona: 'alice' });
    const attackerAdapter = new MockWalletAdapter({ persona: 'payer' });
    const aliceConn = await aliceAdapter.connect();
    await attackerAdapter.connect();

    const challenge = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });

    // Attacker signs the challenge with attacker's key, but claims Alice's publicKey
    const attackerSig = await attackerAdapter.signChallenge(challenge.challengeText);

    await expect(
      authService.verifyChallengeAndAuthenticate({
        challengeId: challenge.id,
        provider: 'mock',
        publicKey: aliceConn.publicKey,
        identityKey: aliceConn.identityKey,
        signature: attackerSig.signature,
        ...(attackerSig.keyID ? { keyID: attackerSig.keyID } : {}),
        expectedDomain: appDomain,
      })
    ).rejects.toThrowError(WalletAuthError);

    // Domain mismatch check
    const aliceSig = await aliceAdapter.signChallenge(challenge.challengeText);
    await expect(
      authService.verifyChallengeAndAuthenticate({
        challengeId: challenge.id,
        provider: 'mock',
        publicKey: aliceConn.publicKey,
        identityKey: aliceConn.identityKey,
        signature: aliceSig.signature,
        ...(aliceSig.keyID ? { keyID: aliceSig.keyID } : {}),
        expectedDomain: 'evil-phishing.example.com',
      })
    ).rejects.toThrowError(/domain mismatch/i);
  });

  it('4. Rejects an expired authentication challenge', async () => {
    const adapter = new MockWalletAdapter({ persona: 'alice' });
    const conn = await adapter.connect();

    const issuedAt = new Date('2026-11-15T00:00:00.000Z');
    const challenge = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
      ttlMs: 60_000, // 1 minute TTL
      now: issuedAt,
    });

    const sig = await adapter.signChallenge(challenge.challengeText);

    // Attempt verification 2 minutes later
    const afterExpiry = new Date('2026-11-15T00:02:01.000Z');

    await expect(
      authService.verifyChallengeAndAuthenticate({
        challengeId: challenge.id,
        provider: 'mock',
        publicKey: conn.publicKey,
        identityKey: conn.identityKey,
        signature: sig.signature,
        ...(sig.keyID ? { keyID: sig.keyID } : {}),
        expectedDomain: appDomain,
        now: afterExpiry,
      })
    ).rejects.toThrowError(/expired/i);
  });

  it('5. Rejects a reused authentication challenge (single-use replay protection)', async () => {
    const adapter = new MockWalletAdapter({ persona: 'alice' });
    const conn = await adapter.connect();

    const challenge = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });

    const sig = await adapter.signChallenge(challenge.challengeText);

    // First use succeeds
    const firstResult = await authService.verifyChallengeAndAuthenticate({
      challengeId: challenge.id,
      provider: 'mock',
      publicKey: conn.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      expectedDomain: appDomain,
    });
    expect(firstResult.sessionToken).toBeTruthy();

    // Second use of the exact same challengeId + signature MUST fail with CHALLENGE_REUSED
    try {
      await authService.verifyChallengeAndAuthenticate({
        challengeId: challenge.id,
        provider: 'mock',
        publicKey: conn.publicKey,
        identityKey: conn.identityKey,
        signature: sig.signature,
        ...(sig.keyID ? { keyID: sig.keyID } : {}),
        expectedDomain: appDomain,
      });
      expect.fail('Expected reused challenge to throw WalletAuthError');
    } catch (error) {
      expect(error).toBeInstanceOf(WalletAuthError);
      expect((error as WalletAuthError).code).toBe('CHALLENGE_REUSED');
    }
  });

  it('6. Throws UnsupportedWalletOperationError for unimplemented Phase 5 payment operations and legacy auth-only minting, and blocks live BRC-100 minting in mock mode', async () => {
    const mockAdapter = new MockWalletAdapter();
    await mockAdapter.connect();

    const yoursSub = createBRC100WalletSubstrate({
      seedLabel: 'yours-unsupported-op',
      version: 'yours-2.5.0',
    });
    const yoursAdapter = new YoursWalletAdapter({
      brc100Wallet: yoursSub.walletClient,
    });
    await yoursAdapter.connect();

    const yoursLegacyExt = createYoursInjectedExtension('yours-legacy-auth-only');
    const yoursLegacyAdapter = new YoursWalletAdapter({
      injectedExtension: yoursLegacyExt.extension,
    });
    await yoursLegacyAdapter.connect();
    expect(yoursLegacyAdapter.getCapabilities().canMintOrdinal).toBe(false);

    const handcashSub = createBRC100WalletSubstrate({
      seedLabel: 'handcash-unsupported-op',
      version: 'handcash-1.4.0',
    });
    const handcashAdapter = new HandCashWalletAdapter({
      brc100Wallet: handcashSub.walletClient,
    });
    await handcashAdapter.connect();

    for (const adapter of [
      mockAdapter,
      yoursAdapter,
      yoursLegacyAdapter,
      handcashAdapter,
    ]) {
      await expect(
        adapter.sendOutputs([
          {
            lockingScript: '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac',
            satoshis: 700,
            description: 'Owner payout',
          },
        ])
      ).rejects.toThrowError(UnsupportedWalletOperationError);
    }

    const mintInput = {
      contentBase64: 'dGVzdA==',
      contentType: 'application/json',
      metadata: {
        app: 'community-platform' as const,
        type: 'ord' as const,
        name: 'Test Community',
        communityId: '00000000-0000-0000-0000-000000000001',
        schemaVersion: 1 as const,
        platform: 'community-platform' as const,
      },
    };

    // Legacy window.yours extension is authentication-only
    await expect(yoursLegacyAdapter.mintOrdinal(mintInput)).rejects.toThrowError(
      UnsupportedWalletOperationError
    );

    // Live BRC-100 substrates cannot mint while APP_MODE="mock"
    for (const liveAdapter of [yoursAdapter, handcashAdapter]) {
      await expect(liveAdapter.mintOrdinal(mintInput)).rejects.toThrow(
        /disabled while APP_MODE is "mock"/i
      );
    }

    // MockWalletAdapter supports simulated 1Sat Ordinal minting in mock mode
    const mockMintResult = await mockAdapter.mintOrdinal(mintInput);
    expect(mockMintResult.isMock).toBe(true);
    expect(mockMintResult.origin).toBe(`${mockMintResult.txid}_0`);
  });

  it('7. Handles wallet disconnection cleanly on both adapter and persistent server session', async () => {
    const adapter = new MockWalletAdapter({ persona: 'alice' });
    const conn = await adapter.connect();
    const identityBefore = await adapter.getIdentity();
    expect(identityBefore.identityKey).toBe(conn.identityKey);

    const challenge = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });
    const sig = await adapter.signChallenge(challenge.challengeText);

    const verified = await authService.verifyChallengeAndAuthenticate({
      challengeId: challenge.id,
      provider: 'mock',
      publicKey: conn.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      expectedDomain: appDomain,
    });

    // Disconnect client adapter
    await adapter.disconnect();
    await expect(adapter.getIdentity()).rejects.toThrowError(WalletConnectionError);

    // Disconnect server wallet connection -> revokes session since it was the only wallet
    const disconnectRes = await authService.disconnectWallet({
      sessionToken: verified.sessionToken,
    });
    expect(disconnectRes.disconnectedWallet.connected).toBe(false);
    expect(disconnectRes.sessionRevoked).toBe(true);

    // Subsequent session check fails
    await expect(
      authService.getSessionContext(verified.sessionToken)
    ).rejects.toThrowError(WalletAuthError);
  });

  it('8. Enforces server-side session expiration and rejects tampered session tokens', async () => {
    const adapter = new MockWalletAdapter({ persona: 'alice' });
    const conn = await adapter.connect();

    const startTime = new Date('2026-11-15T12:00:00.000Z');
    const challenge = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
      now: startTime,
    });
    const sig = await adapter.signChallenge(challenge.challengeText);

    const verified = await authService.verifyChallengeAndAuthenticate({
      challengeId: challenge.id,
      provider: 'mock',
      publicKey: conn.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      expectedDomain: appDomain,
      sessionTtlMs: 30 * 60 * 1000, // 30 minutes
      now: startTime,
    });

    // Valid after 10 minutes
    const tenMinutesLater = new Date('2026-11-15T12:10:00.000Z');
    const context = await authService.getSessionContext(
      verified.sessionToken,
      tenMinutesLater
    );
    expect(context.user.id).toBe(verified.user.id);

    // Expired after 31 minutes
    const thirtyOneMinutesLater = new Date('2026-11-15T12:31:00.000Z');
    await expect(
      authService.getSessionContext(verified.sessionToken, thirtyOneMinutesLater)
    ).rejects.toThrowError(/expired/i);

    // Tampered HMAC signature is rejected immediately
    const tamperedToken = `${verified.session.sessionId}.${'0'.repeat(64)}`;
    await expect(
      authService.getSessionContext(tamperedToken, tenMinutesLater)
    ).rejects.toThrowError(/HMAC signature verification failed/i);
  });

  it('9. Links an additional wallet to an existing account and blocks unauthorized cross-account wallet claiming', async () => {
    // Alice authenticates with Yours Wallet first
    const aliceYours = createBRC100WalletSubstrate({
      seedLabel: 'alice-yours-wallet',
      version: 'yours-2.5.0',
    });
    const aliceYoursAdapter = new YoursWalletAdapter({
      brc100Wallet: aliceYours.walletClient,
    });
    const aliceYoursConn = await aliceYoursAdapter.connect();

    const challenge1 = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sig1 = await aliceYoursAdapter.signChallenge(challenge1.challengeText);

    const aliceAuth1 = await authService.verifyChallengeAndAuthenticate({
      challengeId: challenge1.id,
      provider: 'yours',
      publicKey: sig1.publicKey,
      identityKey: aliceYoursConn.identityKey,
      signature: sig1.signature,
      ...(sig1.keyID ? { keyID: sig1.keyID } : {}),
      expectedDomain: appDomain,
    });
    expect(aliceAuth1.wallets).toHaveLength(1);

    // Alice now links a second Yours wallet while authenticated with her existing session token
    const aliceHandCash = createBRC100WalletSubstrate({
      seedLabel: 'alice-second-yours-wallet',
      version: 'yours-2.5.0',
    });
    const aliceHandCashAdapter = new YoursWalletAdapter({
      brc100Wallet: aliceHandCash.walletClient,
    });
    const aliceHandCashConn = await aliceHandCashAdapter.connect();

    const challenge2 = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
      currentSessionToken: aliceAuth1.sessionToken,
    });
    const sig2 = await aliceHandCashAdapter.signChallenge(challenge2.challengeText);

    const aliceAuth2 = await authService.verifyChallengeAndAuthenticate({
      challengeId: challenge2.id,
      provider: 'yours',
      publicKey: sig2.publicKey,
      identityKey: aliceHandCashConn.identityKey,
      signature: sig2.signature,
      ...(sig2.keyID ? { keyID: sig2.keyID } : {}),
      expectedDomain: appDomain,
      currentSessionToken: aliceAuth1.sessionToken,
    });

    expect(aliceAuth2.linkedExistingAccount).toBe(true);
    expect(aliceAuth2.user.id).toBe(aliceAuth1.user.id);
    expect(aliceAuth2.wallets).toHaveLength(2);
    expect(aliceAuth2.wallets.map((w) => w.provider)).toEqual(['yours', 'yours']);

    // Now Bob creates a separate account and tries to link Alice's Yours wallet to Bob's account -> MUST FAIL
    const bobMockAdapter = new MockWalletAdapter({ persona: 'bob' });
    const bobConn = await bobMockAdapter.connect();
    const bobChallenge1 = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });
    const bobSig1 = await bobMockAdapter.signChallenge(bobChallenge1.challengeText);
    const bobAuth = await authService.verifyChallengeAndAuthenticate({
      challengeId: bobChallenge1.id,
      provider: 'mock',
      publicKey: bobConn.publicKey,
      identityKey: bobConn.identityKey,
      signature: bobSig1.signature,
      ...(bobSig1.keyID ? { keyID: bobSig1.keyID } : {}),
      expectedDomain: appDomain,
    });
    expect(bobAuth.user.id).not.toBe(aliceAuth1.user.id);

    // Bob attempts to link Alice's already-linked Yours wallet to Bob's session
    const bobLinkChallenge = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
      currentSessionToken: bobAuth.sessionToken,
    });
    const stolenOrSignedByAlice = await aliceYoursAdapter.signChallenge(
      bobLinkChallenge.challengeText
    );

    try {
      await authService.verifyChallengeAndAuthenticate({
        challengeId: bobLinkChallenge.id,
        provider: 'yours',
        publicKey: stolenOrSignedByAlice.publicKey,
        identityKey: aliceYoursConn.identityKey,
        signature: stolenOrSignedByAlice.signature,
        ...(stolenOrSignedByAlice.keyID
          ? { keyID: stolenOrSignedByAlice.keyID }
          : {}),
        expectedDomain: appDomain,
        currentSessionToken: bobAuth.sessionToken,
      });
      expect.fail('Expected unauthorized cross-account wallet link to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(WalletAuthError);
      expect((error as WalletAuthError).code).toBe('UNAUTHORIZED_WALLET_LINK');
      expect((error as WalletAuthError).statusCode).toBe(409);
    }
  });

  it('10. Offers only Yours (plus mock in mock mode) while HandCash is disabled, and Yours rejects a HandCash substrate', async () => {
    const yoursSub = createBRC100WalletSubstrate({
      seedLabel: 'dual-env-yours',
      version: 'yours-2.5.0',
    });
    const handcashSub = createBRC100WalletSubstrate({
      seedLabel: 'dual-env-handcash',
      version: 'handcash-1.4.2',
    });

    // Even with a HandCash substrate present, discovery does not offer HandCash
    const discovered = await discoverAvailableWallets({
      appMode: 'mock',
      yoursOptions: { brc100Wallet: yoursSub.walletClient },
      handcashOptions: { brc100Wallet: handcashSub.walletClient },
    });
    expect(discovered.map((d) => d.provider)).toEqual(['yours', 'mock']);
    expect(discovered.find((d) => d.provider === 'yours')?.available).toBe(true);

    // Explicit 'yours' selection connects to Yours Wallet
    const selectedYours = createExplicitWalletAdapter('yours', {
      yoursOptions: { brc100Wallet: yoursSub.walletClient },
    });
    const yoursIdentity = await selectedYours.connect();
    expect(yoursIdentity.provider).toBe('yours');
    expect(yoursIdentity.identityKey).toBe(yoursSub.identityKeyHex);

    // Explicit 'handcash' selection is refused
    expect(() =>
      createExplicitWalletAdapter('handcash', {
        handcashOptions: { brc100Wallet: handcashSub.walletClient },
      })
    ).toThrowError(WalletConnectionError);

    // A wallet on window.CWI that identifies as HandCash is still refused by the Yours adapter
    const mismatchedYours = new YoursWalletAdapter({
      brc100Wallet: handcashSub.walletClient,
    });
    await expect(mismatchedYours.connect()).rejects.toMatchObject({
      code: 'PROVIDER_MISMATCH',
    });
  });

  it('11. Persists users, wallets, challenges, sessions, and audit events in PostgreSQL and enforces DB-level unique wallet identities', async () => {
    const adapter = new MockWalletAdapter({ persona: 'alice', network: 'test' });
    const conn = await adapter.connect();

    const challenge = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });
    const sig = await adapter.signChallenge(challenge.challengeText);
    const verified = await authService.verifyChallengeAndAuthenticate({
      challengeId: challenge.id,
      provider: 'mock',
      publicKey: sig.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      network: 'test',
      expectedDomain: appDomain,
    });

    // Verify PostgreSQL tables directly via Prisma
    const dbUser = await prisma.user.findUnique({ where: { id: verified.user.id } });
    const dbWallet = await prisma.walletConnection.findUnique({
      where: {
        provider_identityKey: {
          provider: 'mock',
          identityKey: conn.identityKey,
        },
      },
    });
    const dbChallenge = await prisma.authChallenge.findUnique({
      where: { id: challenge.id },
    });
    const dbSession = await prisma.authSession.findUnique({
      where: { sessionId: verified.session.sessionId },
    });
    const auditEvents = await authService.getAuditEvents();

    expect(dbUser?.id).toBe(verified.user.id);
    expect(dbWallet?.id).toBe(verified.activeWallet.id);
    expect(dbWallet?.connected).toBe(true);
    expect(dbChallenge?.usedAt).toBeInstanceOf(Date);
    expect(dbSession?.userId).toBe(verified.user.id);
    expect(auditEvents.map((e) => e.eventType)).toEqual([
      'AUTH_CHALLENGE_ISSUED',
      'AUTH_VERIFIED',
    ]);

    // DB-level unique constraint on (provider, identityKey) rejects direct duplicate insert
    const secondUser = await prisma.user.create({
      data: {
        username: 'second_user_db_check',
        displayName: 'Second User',
      },
    });
    await expect(
      prisma.walletConnection.create({
        data: {
          userId: secondUser.id,
          provider: 'mock',
          identityKey: conn.identityKey,
          publicKey: conn.publicKey,
          currentPayoutScript: conn.payoutScript ?? '',
        },
      })
    ).rejects.toThrow();
  });

  it('12. Prevents concurrent challenge replay atomically when two verification requests race simultaneously', async () => {
    const adapter = new MockWalletAdapter({ persona: 'alice' });
    const conn = await adapter.connect();

    const challenge = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });
    const sig = await adapter.signChallenge(challenge.challengeText);

    const instanceA = new WalletAuthService({
      prisma,
      sessionSecret: testSessionSecret,
      envSource: { BSV_NETWORK: 'test' },
    });
    const instanceB = new WalletAuthService({
      prisma,
      sessionSecret: testSessionSecret,
      envSource: { BSV_NETWORK: 'test' },
    });

    const payload = {
      challengeId: challenge.id,
      provider: 'mock' as const,
      publicKey: conn.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      expectedDomain: appDomain,
    };

    const [resA, resB] = await Promise.allSettled([
      instanceA.verifyChallengeAndAuthenticate(payload),
      instanceB.verifyChallengeAndAuthenticate(payload),
    ]);

    const fulfilled = [resA, resB].filter((r) => r.status === 'fulfilled');
    const rejected = [resA, resB].filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(WalletAuthError);
    expect((rejected[0]!.reason as WalletAuthError).code).toBe('CHALLENGE_REUSED');
  });

  it('13. Shares session state and propagates logout/disconnect revocation across separate WalletAuthService instances', async () => {
    const adapter = new MockWalletAdapter({ persona: 'bob' });
    const conn = await adapter.connect();

    const instanceA = new WalletAuthService({
      prisma,
      sessionSecret: testSessionSecret,
      envSource: { BSV_NETWORK: 'test' },
    });
    const instanceB = new WalletAuthService({
      prisma,
      sessionSecret: testSessionSecret,
      envSource: { BSV_NETWORK: 'test' },
    });

    const challenge = await instanceA.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });
    const sig = await adapter.signChallenge(challenge.challengeText);
    const verified = await instanceA.verifyChallengeAndAuthenticate({
      challengeId: challenge.id,
      provider: 'mock',
      publicKey: conn.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      expectedDomain: appDomain,
    });

    // Separate instanceB immediately resolves session issued by instanceA from PostgreSQL
    const ctxB = await instanceB.getSessionContext(verified.sessionToken);
    expect(ctxB.user.id).toBe(verified.user.id);
    expect(ctxB.activeWallet?.identityKey).toBe(conn.identityKey);

    // instanceA logs out -> revokes persistent session in PostgreSQL
    await instanceA.logout(verified.sessionToken);

    // instanceB immediately rejects revoked session
    await expect(
      instanceB.getSessionContext(verified.sessionToken)
    ).rejects.toThrowError(/revoked/i);

    // Also verify disconnectWallet on instanceA revokes across instanceB
    const challenge2 = await instanceA.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });
    const sig2 = await adapter.signChallenge(challenge2.challengeText);
    const verified2 = await instanceA.verifyChallengeAndAuthenticate({
      challengeId: challenge2.id,
      provider: 'mock',
      publicKey: conn.publicKey,
      identityKey: conn.identityKey,
      signature: sig2.signature,
      ...(sig2.keyID ? { keyID: sig2.keyID } : {}),
      expectedDomain: appDomain,
    });

    const disconnectResult = await instanceA.disconnectWallet({
      sessionToken: verified2.sessionToken,
    });
    expect(disconnectResult.sessionRevoked).toBe(true);

    await expect(
      instanceB.getSessionContext(verified2.sessionToken)
    ).rejects.toThrowError(/revoked/i);
  });

  it('14. Enforces production SESSION_SECRET requirements and Secure cookie flags in SessionStore', async () => {
    expect(
      () =>
        new SessionStore({
          prisma,
          envSource: { NODE_ENV: 'production' },
        })
    ).toThrow(/SESSION_SECRET/i);

    expect(
      () =>
        new SessionStore({
          prisma,
          secret: 'too-short',
          envSource: { NODE_ENV: 'production' },
        })
    ).toThrow(/at least 32 characters/i);

    expect(
      () =>
        new SessionStore({
          prisma,
          secret: 'development-only-session-secret-change-in-production-32chars',
          envSource: { NODE_ENV: 'production' },
        })
    ).toThrow(/placeholder/i);

    // Strong secret in production/live produces Secure + HttpOnly + SameSite=lax cookies using a real provider (Yours)
    const yoursProdSub = createBRC100WalletSubstrate({
      seedLabel: 'prod-cookie-yours-user',
      version: 'yours-2.5.0',
      network: 'testnet',
    });
    const yoursProdAdapter = new YoursWalletAdapter({
      brc100Wallet: yoursProdSub.walletClient,
    });
    const conn = await yoursProdAdapter.connect();
    const prodService = new WalletAuthService({
      prisma,
      sessionSecret: 'prod-9f8e7d6c5b4a3928172635445566778899aabbccddeeff',
      envSource: { NODE_ENV: 'production', APP_MODE: 'live', BSV_NETWORK: 'test' },
    });

    const challenge = await prodService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sig = await yoursProdAdapter.signChallenge(challenge.challengeText);
    const authRes = await prodService.verifyChallengeAndAuthenticate({
      challengeId: challenge.id,
      provider: 'yours',
      publicKey: sig.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      ...(sig.signatureScheme ? { signatureScheme: sig.signatureScheme } : {}),
      expectedDomain: appDomain,
    });

    expect(authRes.cookie.httpOnly).toBe(true);
    expect(authRes.cookie.sameSite).toBe('lax');
    expect(authRes.cookie.path).toBe('/');
    expect(authRes.cookie.secure).toBe(true);

    const expiredCookie = prodService.sessionStore.buildExpiredCookie();
    expect(expiredCookie.secure).toBe(true);
    expect(expiredCookie.httpOnly).toBe(true);
    expect(expiredCookie.maxAge).toBe(0);
  });

  it('15. Enforces server-configured BSV_NETWORK and does not silently derive payoutScript from identityKey', async () => {
    const mainnetAuthService = new WalletAuthService({
      prisma,
      sessionSecret: testSessionSecret,
      envSource: { BSV_NETWORK: 'main' },
    });

    // HandCash BRC-100 adapter does NOT silently derive a payoutScript from identityKey
    const handcashSub = createBRC100WalletSubstrate({
      seedLabel: 'handcash-no-silent-payout',
      version: 'handcash-1.4.2',
      network: 'mainnet',
    });
    const handcashAdapter = new HandCashWalletAdapter({
      brc100Wallet: handcashSub.walletClient,
    });
    const hcConn = await handcashAdapter.connect();
    expect(hcConn.payoutScript).toBeUndefined();

    // Yours BRC-100 CWI adapter does NOT silently derive a payoutScript from identityKey
    const yoursSub = createBRC100WalletSubstrate({
      seedLabel: 'yours-no-silent-payout',
      version: 'yours-2.5.0',
      network: 'mainnet',
    });
    const yoursAdapter = new YoursWalletAdapter({
      brc100Wallet: yoursSub.walletClient,
    });
    const yoursConn = await yoursAdapter.connect();
    expect(yoursConn.payoutScript).toBeUndefined();

    // Client supplying mismatched network ('test' when server is 'main') is rejected
    const challengeMismatch = await mainnetAuthService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sigMismatch = await yoursAdapter.signChallenge(
      challengeMismatch.challengeText
    );
    await expect(
      mainnetAuthService.verifyChallengeAndAuthenticate({
        challengeId: challengeMismatch.id,
        provider: 'yours',
        publicKey: sigMismatch.publicKey,
        identityKey: yoursConn.identityKey,
        signature: sigMismatch.signature,
        ...(sigMismatch.keyID ? { keyID: sigMismatch.keyID } : {}),
        network: 'test',
        expectedDomain: appDomain,
      })
    ).rejects.toMatchObject({
      code: 'NETWORK_MISMATCH',
      statusCode: 400,
    });

    // Valid authentication on server's network stores network='main' and payoutScript=null when not explicitly provided
    const challengeValid = await mainnetAuthService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sigValid = await yoursAdapter.signChallenge(
      challengeValid.challengeText
    );
    const verified = await mainnetAuthService.verifyChallengeAndAuthenticate({
      challengeId: challengeValid.id,
      provider: 'yours',
      publicKey: sigValid.publicKey,
      identityKey: yoursConn.identityKey,
      signature: sigValid.signature,
      ...(sigValid.keyID ? { keyID: sigValid.keyID } : {}),
      expectedDomain: appDomain,
    });
    expect(verified.activeWallet.network).toBe('main');
    expect(verified.activeWallet.payoutScript).toBeNull();
  });

  it('16. Retains Yours BRC-100 WalletInterface (window.CWI) and accurately reports capabilities vs legacy window.yours', async () => {
    const yoursSub = createBRC100WalletSubstrate({
      seedLabel: 'yours-cwi-retain',
      version: 'yours-3.0.0',
      network: 'testnet',
    });
    const yoursCwi = new YoursWalletAdapter({
      brc100Wallet: yoursSub.walletClient,
    });

    const conn = await yoursCwi.connect();
    expect(conn.network).toBe('test');
    expect(yoursCwi.getWalletInterface()).toBe(yoursSub.walletClient);
    expect(yoursCwi.getCapabilities()).toEqual({
      canAuthenticate: true,
      canMintOrdinal: true,
      canSendOutputs: false,
      supportsBrc100: true,
      connectionTransport: 'brc100-cwi',
    });

    // Global window.CWI detection
    const globalRef = globalThis as unknown as { window?: { CWI?: unknown } };
    const previousWindow = globalRef.window;
    globalRef.window = { CWI: yoursSub.walletClient };
    try {
      const detectedAdapter = new YoursWalletAdapter();
      expect(await detectedAdapter.isAvailable()).toBe(true);
      expect(detectedAdapter.getCapabilities().connectionTransport).toBe(
        'brc100-cwi'
      );
      const detectedConn = await detectedAdapter.connect();
      expect(detectedConn.identityKey).toBe(yoursSub.identityKeyHex);
      expect(detectedAdapter.getWalletInterface()).not.toBeNull();
    } finally {
      if (previousWindow === undefined) {
        delete globalRef.window;
      } else {
        globalRef.window = previousWindow;
      }
    }

    // Legacy window.yours exposes auth-only capabilities
    const legacy = createYoursInjectedExtension('yours-legacy-caps');
    const legacyAdapter = new YoursWalletAdapter({
      injectedExtension: legacy.extension,
    });
    await legacyAdapter.connect();
    expect(legacyAdapter.getWalletInterface()).toBeNull();
    expect(legacyAdapter.getCapabilities()).toEqual({
      canAuthenticate: true,
      canMintOrdinal: false,
      canSendOutputs: false,
      supportsBrc100: false,
      connectionTransport: 'legacy-yours',
    });
  });

  it('17. Probes HandCash Desktop BRC-100 bridge endpoints (2121 -> 3321), checks version, and normalizes lock/rejection/network errors', async () => {
    const hcSub = createBRC100WalletSubstrate({
      seedLabel: 'handcash-fallback-probe',
      version: 'handcash-1.5.0',
      network: 'testnet',
    });

    const probedEndpoints: string[] = [];
    const fallbackAdapter = new HandCashWalletAdapter({
      clientFactory: (endpoint) => {
        probedEndpoints.push(endpoint);
        if (endpoint === HANDCASH_PRIMARY_BRIDGE_URL) {
          return {
            async getVersion() {
              throw new Error('fetch failed ECONNREFUSED');
            },
          } as unknown as WalletInterface;
        }
        return hcSub.walletClient;
      },
    });

    const discovery = await fallbackAdapter.discoverBridge();
    expect(discovery.available).toBe(true);
    expect(discovery.version).toBe('handcash-1.5.0');
    expect(probedEndpoints).toEqual([
      HANDCASH_PRIMARY_BRIDGE_URL,
      HANDCASH_FALLBACK_BRIDGE_URL,
    ]);

    const conn = await fallbackAdapter.connect();
    expect(conn.provider).toBe('handcash');
    expect(conn.identityKey).toBe(hcSub.identityKeyHex);
    expect(conn.network).toBe('test');
    expect(fallbackAdapter.getWalletInterface()).toBe(hcSub.walletClient);
    expect(fallbackAdapter.getCapabilities()).toEqual({
      canAuthenticate: true,
      canMintOrdinal: true,
      canSendOutputs: false,
      supportsBrc100: true,
      connectionTransport: 'brc100-http',
    });

    // Rejects non-HandCash version running on bridge port
    const wrongVendorAdapter = new HandCashWalletAdapter({
      clientFactory: () =>
        createBRC100WalletSubstrate({
          seedLabel: 'wrong-vendor-bridge',
          version: 'yours-2.5.0',
        }).walletClient,
    });
    await expect(wrongVendorAdapter.connect()).rejects.toMatchObject({
      name: 'WalletConnectionError',
      provider: 'handcash',
      code: 'PROVIDER_MISMATCH',
    });

    // Normalizes locked wallet
    const lockedAdapter = new HandCashWalletAdapter({
      brc100Wallet: {
        async getVersion() {
          return { version: 'handcash-1.5.0' };
        },
        async waitForAuthentication() {
          return { authenticated: false } as unknown as {
            authenticated: true;
          };
        },
      } as unknown as WalletInterface,
    });
    await expect(lockedAdapter.connect()).rejects.toMatchObject({
      name: 'WalletConnectionError',
      provider: 'handcash',
      code: 'WALLET_LOCKED',
    });

    // Normalizes user rejection
    const rejectedAdapter = new HandCashWalletAdapter({
      brc100Wallet: {
        async getVersion() {
          return { version: 'handcash-1.5.0' };
        },
        async waitForAuthentication() {
          throw new Error('User rejected wallet approval prompt');
        },
      } as unknown as WalletInterface,
    });
    await expect(rejectedAdapter.connect()).rejects.toMatchObject({
      name: 'WalletConnectionError',
      provider: 'handcash',
      code: 'USER_REJECTED',
    });
  });

  it('18. Accepts any non-HandCash BRC-100 version on window.CWI and waits for late extension injection', async () => {
    // Undocumented / generic vendor version strings must not block a real Yours wallet
    expect(isYoursCompatibleVersion('yours-2.9.0')).toBe(true);
    expect(isYoursCompatibleVersion('wallet-brc100-1.0.0')).toBe(true);
    expect(isYoursCompatibleVersion('0.4.1')).toBe(true);
    expect(isYoursCompatibleVersion('HandCash-1.5.0')).toBe(false);
    expect(isYoursCompatibleVersion('   ')).toBe(false);

    const genericSub = createBRC100WalletSubstrate({
      seedLabel: 'generic-version-yours',
      version: 'wallet-brc100-1.0.0',
    });
    const genericConn = await new YoursWalletAdapter({
      brc100Wallet: genericSub.walletClient,
    }).connect();
    expect(genericConn.provider).toBe('yours');
    expect(genericConn.version).toBe('wallet-brc100-1.0.0');
    expect(genericConn.capabilities?.canMintOrdinal).toBe(true);

    // Simulate a browser where the extension injects window.CWI ~200ms after page load
    const lateSub = createBRC100WalletSubstrate({
      seedLabel: 'late-injected-yours',
      version: 'yours-3.0.0',
    });
    const g = globalThis as unknown as { window?: { CWI?: unknown } };
    const previousWindow = g.window;
    g.window = {};
    const timer = setTimeout(() => {
      if (g.window) g.window.CWI = lateSub.walletClient;
    }, 200);
    try {
      const adapter = new YoursWalletAdapter({ cwiInjectionWaitMs: 1500 });
      expect(await adapter.isAvailable()).toBe(true);
      const lateConn = await adapter.connect();
      expect(lateConn.identityKey).toBe(lateSub.identityKeyHex);
      expect(lateConn.capabilities?.connectionTransport).toBe('brc100-cwi');

      // Without the extension at all, connect fails fast after the wait with WALLET_NOT_FOUND
      g.window = {};
      await expect(
        new YoursWalletAdapter({ cwiInjectionWaitMs: 150 }).connect()
      ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    } finally {
      clearTimeout(timer);
      if (previousWindow === undefined) {
        delete g.window;
      } else {
        g.window = previousWindow;
      }
    }
  });

  it('19. Derives and cryptographically verifies BRC-42 destination keys separate from identityKey, rejecting forged or unproven payoutScripts', async () => {
    const yoursSub = createBRC100WalletSubstrate({
      seedLabel: 'dest-proof-yours',
      version: 'yours-2.8.0',
      network: 'testnet',
    });
    const yoursAdapter = new YoursWalletAdapter({
      brc100Wallet: yoursSub.walletClient,
    });
    const conn = await yoursAdapter.connect();

    const destProof = await yoursAdapter.deriveDestination();
    expect(destProof.publicKey).not.toBe(conn.identityKey);
    expect(destProof.lockingScript).toBe(
      deriveP2PKHScriptFromPublicKey(destProof.publicKey)
    );
    const verifiedProofResult = await verifyDestinationOwnershipProof({
      provider: 'yours',
      identityKey: conn.identityKey,
      payoutScript: destProof.lockingScript,
      destinationProof: destProof,
    });
    expect(verifiedProofResult.valid).toBe(true);

    // Reject supplying payoutScript without cryptographic destinationProof
    const ch1 = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sig1 = await yoursAdapter.signChallenge(ch1.challengeText);
    await expect(
      authService.verifyChallengeAndAuthenticate({
        challengeId: ch1.id,
        provider: 'yours',
        publicKey: sig1.publicKey,
        identityKey: conn.identityKey,
        signature: sig1.signature,
        ...(sig1.keyID ? { keyID: sig1.keyID } : {}),
        payoutScript: destProof.lockingScript,
        expectedDomain: appDomain,
      })
    ).rejects.toMatchObject({
      code: 'INVALID_DESTINATION_PROOF',
      statusCode: 400,
    });

    // Reject spoofing a destinationProof with root identityKey instead of derived child key
    const rootP2PKH = deriveP2PKHScriptFromPublicKey(conn.identityKey);
    const rootMsg = formatDestinationOwnershipProofMessage({
      provider: 'yours',
      identityKey: conn.identityKey,
      destinationPublicKey: conn.identityKey,
      lockingScript: rootP2PKH,
      keyID: 'destination-0',
    });
    const rootProto = new ProtoWallet(yoursSub.privateKey);
    const { signature: forgedRootSig } = await rootProto.createSignature({
      data: Utils.toArray(rootMsg, 'utf8'),
      protocolID: DESTINATION_BRC100_PROTOCOL_ID,
      keyID: 'destination-0',
      counterparty: 'anyone',
    });
    const forgedProof = {
      publicKey: conn.identityKey,
      lockingScript: rootP2PKH,
      signature: Utils.toHex(Array.from(forgedRootSig)).toLowerCase(),
      signatureScheme: 'brc100' as const,
      proofMessage: rootMsg,
      protocolID: DESTINATION_BRC100_PROTOCOL_ID,
      keyID: 'destination-0',
      counterparty: 'anyone' as const,
    };
    const forgedCheck = await verifyDestinationOwnershipProof({
      provider: 'yours',
      identityKey: conn.identityKey,
      payoutScript: rootP2PKH,
      destinationProof: forgedProof,
    });
    expect(forgedCheck.valid).toBe(false);

    // Authenticate first, then bind verified destination via updateVerifiedWalletDestination
    const ch2 = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sig2 = await yoursAdapter.signChallenge(ch2.challengeText);
    const sessionRes = await authService.verifyChallengeAndAuthenticate({
      challengeId: ch2.id,
      provider: 'yours',
      publicKey: sig2.publicKey,
      identityKey: conn.identityKey,
      signature: sig2.signature,
      ...(sig2.keyID ? { keyID: sig2.keyID } : {}),
      expectedDomain: appDomain,
    });
    expect(sessionRes.activeWallet.payoutScript).toBeNull();

    const updatedWallet = await authService.updateVerifiedWalletDestination({
      sessionToken: sessionRes.sessionToken,
      provider: 'yours',
      destinationProof: destProof,
    });
    expect(updatedWallet.payoutScript).toBe(destProof.lockingScript);

    const sessionCtx = await authService.getSessionContext(
      sessionRes.sessionToken
    );
    expect(sessionCtx?.activeWallet?.payoutScript).toBe(
      destProof.lockingScript
    );
  });

  it('20. Rejects provider="mock" on server and API routes when APP_MODE="live" while preserving mock mode in development', async () => {
    const liveAuthService = new WalletAuthService({
      prisma,
      sessionSecret: testSessionSecret,
      envSource: { APP_MODE: 'live', BSV_NETWORK: 'test' },
    });

    // 1. Direct WalletAuthService.issueChallenge rejects mock in live mode (403 MOCK_PROVIDER_FORBIDDEN)
    await expect(
      liveAuthService.issueChallenge({
        provider: 'mock',
        domain: appDomain,
      })
    ).rejects.toMatchObject({
      code: 'MOCK_PROVIDER_FORBIDDEN',
      statusCode: 403,
    });

    // 2. Direct verifyChallengeAndAuthenticate and getSessionContext also reject mock in live mode
    const mockAdapter = new MockWalletAdapter({ persona: 'alice', network: 'test' });
    const mockConn = await mockAdapter.connect();
    const devChallenge = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });
    const devSig = await mockAdapter.signChallenge(devChallenge.challengeText);

    await expect(
      liveAuthService.verifyChallengeAndAuthenticate({
        challengeId: devChallenge.id,
        provider: 'mock',
        publicKey: devSig.publicKey,
        identityKey: mockConn.identityKey,
        signature: devSig.signature,
        ...(devSig.keyID ? { keyID: devSig.keyID } : {}),
        expectedDomain: appDomain,
      })
    ).rejects.toMatchObject({
      code: 'MOCK_PROVIDER_FORBIDDEN',
      statusCode: 403,
    });

    // Authenticate in mock mode, then verify mock session is rejected by live service
    const devSession = await authService.verifyChallengeAndAuthenticate({
      challengeId: devChallenge.id,
      provider: 'mock',
      publicKey: devSig.publicKey,
      identityKey: mockConn.identityKey,
      signature: devSig.signature,
      ...(devSig.keyID ? { keyID: devSig.keyID } : {}),
      expectedDomain: appDomain,
    });
    expect(devSession.activeWallet.provider).toBe('mock');

    await expect(
      liveAuthService.getSessionContext(devSession.sessionToken)
    ).rejects.toMatchObject({
      code: 'MOCK_PROVIDER_FORBIDDEN',
      statusCode: 403,
    });

    // 3. HTTP Route Handlers (/api/auth/challenge, /api/auth/verify, /api/wallets/connect)
    const globalAuthHolder = globalThis as unknown as {
      walletAuthServiceSingleton?: WalletAuthService;
    };
    const previousSingleton = globalAuthHolder.walletAuthServiceSingleton;
    const prevAppMode = process.env.APP_MODE;
    const prevAppUrl = process.env.NEXT_PUBLIC_APP_URL;

    try {
      process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
      process.env.APP_MODE = 'live';
      globalAuthHolder.walletAuthServiceSingleton = liveAuthService;

      const liveChallengeReq = new NextRequest('http://localhost:3000/api/auth/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost:3000' },
        body: JSON.stringify({ provider: 'mock' }),
      });
      const liveChallengeRes = await challengePostRoute(liveChallengeReq);
      expect(liveChallengeRes.status).toBe(403);
      const liveChallengeJson = (await liveChallengeRes.json()) as { error: string };
      expect(liveChallengeJson.error).toBe('MOCK_PROVIDER_FORBIDDEN');

      const fakeVerifyPayload = {
        challengeId: '11111111-1111-4111-8111-111111111111',
        provider: 'mock',
        publicKey: mockConn.publicKey,
        identityKey: mockConn.identityKey,
        signature: devSig.signature,
        keyID: devSig.keyID,
      };

      const liveVerifyRes = await verifyPostRoute(
        new NextRequest('http://localhost:3000/api/auth/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json', host: 'localhost:3000' },
          body: JSON.stringify(fakeVerifyPayload),
        })
      );
      expect(liveVerifyRes.status).toBe(403);
      expect(((await liveVerifyRes.json()) as { error: string }).error).toBe(
        'MOCK_PROVIDER_FORBIDDEN'
      );

      const liveConnectRes = await walletConnectPostRoute(
        new NextRequest('http://localhost:3000/api/wallets/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json', host: 'localhost:3000' },
          body: JSON.stringify(fakeVerifyPayload),
        })
      );
      expect(liveConnectRes.status).toBe(403);
      expect(((await liveConnectRes.json()) as { error: string }).error).toBe(
        'MOCK_PROVIDER_FORBIDDEN'
      );

      // Verify mock mode routes STILL succeed in local development (APP_MODE="mock")
      process.env.APP_MODE = 'mock';
      globalAuthHolder.walletAuthServiceSingleton = authService;

      const mockChallengeRes = await challengePostRoute(
        new NextRequest('http://localhost:3000/api/auth/challenge', {
          method: 'POST',
          headers: { 'content-type': 'application/json', host: 'localhost:3000' },
          body: JSON.stringify({ provider: 'mock' }),
        })
      );
      expect(mockChallengeRes.status).toBe(200);
      const issued = (await mockChallengeRes.json()) as {
        challengeId: string;
        challengeText: string;
      };
      const routeSig = await mockAdapter.signChallenge(issued.challengeText);
      const mockVerifyRes = await verifyPostRoute(
        new NextRequest('http://localhost:3000/api/auth/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json', host: 'localhost:3000' },
          body: JSON.stringify({
            challengeId: issued.challengeId,
            provider: 'mock',
            publicKey: routeSig.publicKey,
            identityKey: mockConn.identityKey,
            signature: routeSig.signature,
            keyID: routeSig.keyID,
          }),
        })
      );
      expect(mockVerifyRes.status).toBe(200);
      expect(((await mockVerifyRes.json()) as { authenticated: boolean }).authenticated).toBe(
        true
      );
    } finally {
      globalAuthHolder.walletAuthServiceSingleton = previousSingleton;
      if (prevAppMode === undefined) delete process.env.APP_MODE;
      else process.env.APP_MODE = prevAppMode;
      if (prevAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = prevAppUrl;
    }
  });

  it('21. Hardens resolveRequestDomain against spoofed, comma-separated, and malformed Host / X-Forwarded-Host headers', async () => {
    const devEnv = {
      NODE_ENV: 'development',
      APP_MODE: 'mock',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    };

    // Trusted local development hosts succeed
    expect(
      resolveRequestDomain(
        new NextRequest('http://localhost:3000/api/auth/challenge', {
          headers: { host: 'localhost:3000' },
        }),
        devEnv
      )
    ).toBe('localhost:3000');

    expect(
      resolveRequestDomain(
        new NextRequest('http://127.0.0.1:4000/api/auth/challenge', {
          headers: { host: '127.0.0.1:4000' },
        }),
        devEnv
      )
    ).toBe('127.0.0.1:4000');

    expect(
      resolveRequestDomain(
        new NextRequest('http://localhost:3000/api/auth/challenge', {
          headers: { host: '[::1]:3000' },
        }),
        devEnv
      )
    ).toBe('[::1]:3000');

    // Spoofed Host header rejected
    expect(() =>
      resolveRequestDomain(
        new NextRequest('http://localhost:3000/api/auth/challenge', {
          headers: { host: 'evil-phishing.example.com' },
        }),
        devEnv
      )
    ).toThrowError(WalletAuthError);

    // Spoofed X-Forwarded-Host rejected even when Host is localhost
    expect(() =>
      resolveRequestDomain(
        new NextRequest('http://localhost:3000/api/auth/challenge', {
          headers: {
            host: 'localhost:3000',
            'x-forwarded-host': 'attacker.example.com',
          },
        }),
        devEnv
      )
    ).toThrowError(/x-forwarded-host/i);

    // Comma-separated multi-host Host and X-Forwarded-Host rejected
    expect(() =>
      resolveRequestDomain(
        new NextRequest('http://localhost:3000/api/auth/challenge', {
          headers: { host: 'localhost:3000, evil.com' },
        }),
        devEnv
      )
    ).toThrowError(WalletAuthError);

    expect(() =>
      resolveRequestDomain(
        new NextRequest('http://localhost:3000/api/auth/challenge', {
          headers: {
            host: 'localhost:3000',
            'x-forwarded-host': 'localhost:3000, evil.com',
          },
        }),
        devEnv
      )
    ).toThrowError(WalletAuthError);

    // Malformed authority strings (path, userinfo, out-of-range port, query, empty) rejected
    for (const badHost of [
      '',
      'localhost:3000/evil',
      'user@localhost:3000',
      'localhost:99999',
      'localhost:3000?next=evil',
    ]) {
      expect(() =>
        resolveRequestDomain(
          new NextRequest('http://localhost:3000/api/auth/challenge', {
            headers: { host: badHost },
          }),
          devEnv
        )
      ).toThrowError(WalletAuthError);
    }

    // Live production allowlist: rejects arbitrary localhost, accepts NEXT_PUBLIC_APP_URL and ALLOWED_AUTH_DOMAINS
    const liveDomainEnv = {
      NODE_ENV: 'production',
      APP_MODE: 'live',
      NEXT_PUBLIC_APP_URL: 'https://communities.example.com',
      ALLOWED_AUTH_DOMAINS: 'staging.example.com, preview.example.com',
      TRUST_PROXY_HEADERS: 'true',
    };

    expect(() =>
      resolveRequestDomain(
        new NextRequest('https://communities.example.com/api/auth/challenge', {
          headers: { host: 'localhost:3000' },
        }),
        liveDomainEnv
      )
    ).toThrowError(WalletAuthError);

    expect(
      resolveRequestDomain(
        new NextRequest('https://communities.example.com/api/auth/challenge', {
          headers: {
            host: 'internal-origin:3000',
            'x-forwarded-host': 'preview.example.com',
          },
        }),
        liveDomainEnv
      )
    ).toBe('preview.example.com');

    // When TRUST_PROXY_HEADERS is false, ignore x-forwarded-host (even if in allowlist) and use Host
    expect(
      resolveRequestDomain(
        new NextRequest('https://communities.example.com/api/auth/challenge', {
          headers: {
            host: 'communities.example.com',
            'x-forwarded-host': 'preview.example.com',
          },
        }),
        { ...liveDomainEnv, TRUST_PROXY_HEADERS: 'false' }
      )
    ).toBe('communities.example.com');

    // End-to-end API route rejects spoofed X-Forwarded-Host with 400 DOMAIN_MISMATCH
    const globalAuthHolder = globalThis as unknown as {
      walletAuthServiceSingleton?: WalletAuthService;
    };
    const previousSingleton = globalAuthHolder.walletAuthServiceSingleton;
    const prevAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    try {
      process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
      globalAuthHolder.walletAuthServiceSingleton = authService;

      const spoofedRouteRes = await challengePostRoute(
        new NextRequest('http://localhost:3000/api/auth/challenge', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            host: 'localhost:3000',
            'x-forwarded-host': 'phishing.attacker.example',
          },
          body: JSON.stringify({ provider: 'mock' }),
        })
      );
      expect(spoofedRouteRes.status).toBe(400);
      expect(((await spoofedRouteRes.json()) as { error: string }).error).toBe(
        'DOMAIN_MISMATCH'
      );
    } finally {
      globalAuthHolder.walletAuthServiceSingleton = previousSingleton;
      if (prevAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = prevAppUrl;
    }
  });

  it('22. Verifies Yours window.yours BSM signature compatibility across distinct identityPubKey and bsvPubKey keys and rejects mismatched keys', async () => {
    const idPriv = new PrivateKey(
      Array.from({ length: 32 }, (_, i) => (i + 11) * 3)
    );
    const bsvPriv = new PrivateKey(
      Array.from({ length: 32 }, (_, i) => (i + 47) * 5)
    );
    const ordPriv = new PrivateKey(
      Array.from({ length: 32 }, (_, i) => (i + 83) * 7)
    );
    const unknownPriv = new PrivateKey(
      Array.from({ length: 32 }, (_, i) => (i + 101) * 9)
    );

    const idPubHex = idPriv.toPublicKey().toString().toLowerCase();
    const bsvPubHex = bsvPriv.toPublicKey().toString().toLowerCase();
    const ordPubHex = ordPriv.toPublicKey().toString().toLowerCase();
    expect(idPubHex).not.toBe(bsvPubHex);

    // Case A: window.yours signs BSM challenge with identityPubKey (distinct from bsvPubKey)
    const identitySignedExt: YoursInjectedExtension = {
      isReady: true,
      async connect() {
        return idPubHex;
      },
      async getPubKeys() {
        return {
          identityPubKey: idPubHex,
          bsvPubKey: bsvPubHex,
          ordPubKey: ordPubHex,
        };
      },
      async getNetwork() {
        return 'testnet';
      },
      async signMessage({ message }) {
        const msgBytes = Utils.toArray(message, 'utf8');
        return {
          signedMessage: {
            message,
            sig: BSM.sign(msgBytes, idPriv, 'base64') as string,
            address: idPriv.toPublicKey().toAddress('testnet'),
          },
        };
      },
    };

    const adapterA = new YoursWalletAdapter({
      injectedExtension: identitySignedExt,
    });
    const connA = await adapterA.connect();
    expect(connA.identityKey).toBe(idPubHex);
    expect(connA.payoutScript).toBeUndefined();

    const chA = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sigA = await adapterA.signChallenge(chA.challengeText);
    expect(sigA.publicKey).toBe(idPubHex);

    const authA = await authService.verifyChallengeAndAuthenticate({
      challengeId: chA.id,
      provider: 'yours',
      publicKey: sigA.publicKey,
      identityKey: (await adapterA.getIdentity()).identityKey,
      signature: sigA.signature,
      signatureScheme: 'bsm',
      expectedDomain: appDomain,
    });
    expect(authA.activeWallet.identityKey).toBe(idPubHex);
    expect(authA.activeWallet.payoutScript).toBeNull();

    // Case B: window.yours signs BSM challenge with bsvPubKey (distinct from identityPubKey)
    await authService.clear();
    const bsvSignedExt: YoursInjectedExtension = {
      ...identitySignedExt,
      async signMessage({ message }) {
        const msgBytes = Utils.toArray(message, 'utf8');
        return {
          signedMessage: {
            message,
            sig: BSM.sign(msgBytes, bsvPriv, 'base64') as string,
            address: bsvPriv.toPublicKey().toAddress('testnet'),
          },
        };
      },
    };

    const adapterB = new YoursWalletAdapter({
      injectedExtension: bsvSignedExt,
    });
    await adapterB.connect();

    const chB = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sigB = await adapterB.signChallenge(chB.challengeText);
    // Adapter detects that bsvPubKey actually signed and aligns authenticated publicKey/identityKey to bsvPubKey
    expect(sigB.publicKey).toBe(bsvPubHex);
    expect((await adapterB.getIdentity()).identityKey).toBe(bsvPubHex);
    expect((await adapterB.getIdentity()).payoutScript).toBeUndefined();

    const authB = await authService.verifyChallengeAndAuthenticate({
      challengeId: chB.id,
      provider: 'yours',
      publicKey: sigB.publicKey,
      identityKey: (await adapterB.getIdentity()).identityKey,
      signature: sigB.signature,
      signatureScheme: 'bsm',
      expectedDomain: appDomain,
    });
    expect(authB.activeWallet.identityKey).toBe(bsvPubHex);
    expect(authB.activeWallet.payoutScript).toBeNull();

    // Case B2: WalletConnectionStateManager preserves signing-key alignment after signChallenge()
    await authService.clear();
    const stateManagerB = new WalletConnectionStateManager();
    const stateConnB = await stateManagerB.connectProvider(
      'yours',
      undefined,
      new YoursWalletAdapter({ injectedExtension: bsvSignedExt })
    );
    expect(stateConnB.identityKey).toBe(idPubHex);

    const chB2 = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const stateAuthB2 = await stateManagerB.authenticateWithChallenge(
      chB2.challengeText,
      async (signed) =>
        authService.verifyChallengeAndAuthenticate({
          challengeId: chB2.id,
          provider: signed.provider,
          publicKey: signed.publicKey,
          identityKey: signed.identity.identityKey,
          signature: signed.signature,
          ...(signed.signatureScheme
            ? { signatureScheme: signed.signatureScheme }
            : {}),
          expectedDomain: appDomain,
        })
    );
    expect(stateAuthB2.activeWallet.identityKey).toBe(bsvPubHex);
    expect(stateAuthB2.activeWallet.payoutScript).toBeNull();

    // Case C: window.yours returns a signature from an unknown key not matching getPubKeys() -> rejected immediately
    const badSignedExt: YoursInjectedExtension = {
      ...identitySignedExt,
      async signMessage({ message }) {
        const msgBytes = Utils.toArray(message, 'utf8');
        return {
          signedMessage: {
            message,
            sig: BSM.sign(msgBytes, unknownPriv, 'base64') as string,
            address: unknownPriv.toPublicKey().toAddress('testnet'),
          },
        };
      },
    };
    const adapterC = new YoursWalletAdapter({
      injectedExtension: badSignedExt,
    });
    await adapterC.connect();
    await expect(
      adapterC.signChallenge(chB.challengeText)
    ).rejects.toMatchObject({
      name: 'WalletConnectionError',
      provider: 'yours',
      code: 'AUTHENTICATION_FAILED',
    });
  });
  it('23. Opens the Yours unlock popup only on explicit connect, never on silent page-load reconnect, and times out if the popup is abandoned', async () => {
    const base = createBRC100WalletSubstrate({
      seedLabel: 'locked-yours-wallet',
      version: 'yours-wallet-5.1.1',
    });
    let unlocked = false;
    let unlockPopupsOpened = 0;
    const lockedWallet = {
      ...(base.walletClient as unknown as Record<string, unknown>),
      async isAuthenticated() {
        return { authenticated: unlocked };
      },
      // Mirrors Yours v5: when locked, waitForAuthentication opens the unlock popup and
      // resolves once the user enters their password.
      async waitForAuthentication() {
        if (!unlocked) {
          unlockPopupsOpened += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          unlocked = true; // user typed their password
        }
        return { authenticated: true };
      },
    } as unknown as WalletInterface;

    // Silent (page-load) reconnect must not open the popup
    await expect(
      new YoursWalletAdapter({ brc100Wallet: lockedWallet }).connect({ promptUser: false })
    ).rejects.toMatchObject({ code: 'WALLET_LOCKED' });
    expect(unlockPopupsOpened).toBe(0);

    // Clicking Connect Yours Wallet opens the popup and connects after unlock
    const adapter = new YoursWalletAdapter({ brc100Wallet: lockedWallet });
    const conn = await adapter.connect();
    expect(unlockPopupsOpened).toBe(1);
    expect(conn.identityKey).toBe(base.identityKeyHex);
    expect(conn.version).toBe('yours-wallet-5.1.1');

    // Once unlocked, a silent reconnect succeeds without any popup
    const silent = await new YoursWalletAdapter({ brc100Wallet: lockedWallet }).connect({
      promptUser: false,
    });
    expect(silent.identityKey).toBe(base.identityKeyHex);
    expect(unlockPopupsOpened).toBe(1);

    // If the user abandons the popup, connect fails with a clear message instead of hanging
    const abandonedWallet = {
      ...(base.walletClient as unknown as Record<string, unknown>),
      waitForAuthentication: () => new Promise(() => {}),
    } as unknown as WalletInterface;
    await expect(
      new YoursWalletAdapter({ brc100Wallet: abandonedWallet, unlockTimeoutMs: 50 }).connect()
    ).rejects.toMatchObject({
      code: 'WALLET_LOCKED',
      message: expect.stringContaining('Timed out waiting for Yours Wallet to be unlocked'),
    });
  });
});
