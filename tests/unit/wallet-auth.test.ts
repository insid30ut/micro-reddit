import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BSM, PrivateKey, ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTestPGlitePrisma } from '../helpers/pglite-prisma';
import { MockWalletAdapter } from '../../src/adapters/wallets/mock.adapter.js';
import {
  YoursWalletAdapter,
  type YoursInjectedExtension,
} from '../../src/adapters/wallets/yours.adapter.js';
import { HandCashWalletAdapter } from '../../src/adapters/wallets/handcash.adapter.js';
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

  it('2. Succeeds with HandCash BRC-100 authentication (simulated substrate)', async () => {
    const handcashSub = createBRC100WalletSubstrate({
      seedLabel: 'handcash-brc100-user',
      version: 'handcash-1.4.2',
    });
    const handcashAdapter = new HandCashWalletAdapter({
      brc100Wallet: handcashSub.walletClient,
    });

    const conn = await handcashAdapter.connect();
    expect(conn.provider).toBe('handcash');
    expect(conn.identityKey).toBe(handcashSub.identityKeyHex);
    expect(conn.version).toBe('handcash-1.4.2');

    const challenge = await authService.issueChallenge({
      provider: 'handcash',
      domain: appDomain,
    });

    const sig = await handcashAdapter.signChallenge(challenge.challengeText);
    expect(sig.signatureScheme).toBe('brc100');

    const verified = await authService.verifyChallengeAndAuthenticate({
      challengeId: challenge.id,
      provider: 'handcash',
      publicKey: sig.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      ...(sig.signatureScheme ? { signatureScheme: sig.signatureScheme } : {}),
      expectedDomain: appDomain,
    });

    expect(verified.activeWallet.provider).toBe('handcash');
    expect(verified.activeWallet.identityKey).toBe(handcashSub.identityKeyHex);
    expect(verified.session.provider).toBe('handcash');
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

  it('6. Throws UnsupportedWalletOperationError for unimplemented Phase 5 payment operations and unsupported live minting in mock mode', async () => {
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

    const handcashSub = createBRC100WalletSubstrate({
      seedLabel: 'handcash-unsupported-op',
      version: 'handcash-1.4.0',
    });
    const handcashAdapter = new HandCashWalletAdapter({
      brc100Wallet: handcashSub.walletClient,
    });
    await handcashAdapter.connect();

    for (const adapter of [mockAdapter, yoursAdapter, handcashAdapter]) {
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

    for (const liveAdapter of [yoursAdapter, handcashAdapter]) {
      await expect(
        liveAdapter.mintOrdinal({
          contentBase64: 'dGVzdA==',
          contentType: 'application/json',
          metadata: {
            app: 'community-platform',
            type: 'ord',
            name: 'Test Community',
            communityId: '00000000-0000-0000-0000-000000000001',
            schemaVersion: 1,
            platform: 'community-platform',
          },
        })
      ).rejects.toThrowError(UnsupportedWalletOperationError);
    }

    // MockWalletAdapter supports simulated 1Sat Ordinal minting in Phase 3
    const mockMintResult = await mockAdapter.mintOrdinal({
      contentBase64: 'dGVzdA==',
      contentType: 'application/json',
      metadata: {
        app: 'community-platform',
        type: 'ord',
        name: 'Test Community',
        communityId: '00000000-0000-0000-0000-000000000001',
        schemaVersion: 1,
        platform: 'community-platform',
      },
    });
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

    // Alice now links her HandCash wallet while authenticated with her existing session token
    const aliceHandCash = createBRC100WalletSubstrate({
      seedLabel: 'alice-handcash-wallet',
      version: 'handcash-1.4.2',
    });
    const aliceHandCashAdapter = new HandCashWalletAdapter({
      brc100Wallet: aliceHandCash.walletClient,
    });
    const aliceHandCashConn = await aliceHandCashAdapter.connect();

    const challenge2 = await authService.issueChallenge({
      provider: 'handcash',
      domain: appDomain,
      currentSessionToken: aliceAuth1.sessionToken,
    });
    const sig2 = await aliceHandCashAdapter.signChallenge(challenge2.challengeText);

    const aliceAuth2 = await authService.verifyChallengeAndAuthenticate({
      challengeId: challenge2.id,
      provider: 'handcash',
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
    expect(aliceAuth2.wallets.map((w) => w.provider)).toEqual(['yours', 'handcash']);

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

  it('10. Enforces explicit provider selection when both Yours and HandCash are available and rejects provider mismatch', async () => {
    const yoursSub = createBRC100WalletSubstrate({
      seedLabel: 'dual-env-yours',
      version: 'yours-2.5.0',
    });
    const handcashSub = createBRC100WalletSubstrate({
      seedLabel: 'dual-env-handcash',
      version: 'handcash-1.4.2',
    });

    // Both wallets are available simultaneously in the environment
    const discovered = await discoverAvailableWallets({
      appMode: 'mock',
      yoursOptions: { brc100Wallet: yoursSub.walletClient },
      handcashOptions: { brc100Wallet: handcashSub.walletClient },
    });
    expect(discovered.map((d) => d.provider)).toEqual(['yours', 'handcash', 'mock']);
    expect(discovered.find((d) => d.provider === 'yours')?.available).toBe(true);
    expect(discovered.find((d) => d.provider === 'handcash')?.available).toBe(true);

    // Explicit choice 1: User selects 'yours' -> connects to Yours Wallet
    const selectedYours = createExplicitWalletAdapter('yours', {
      yoursOptions: { brc100Wallet: yoursSub.walletClient },
      handcashOptions: { brc100Wallet: handcashSub.walletClient },
    });
    const yoursIdentity = await selectedYours.connect();
    expect(yoursIdentity.provider).toBe('yours');
    expect(yoursIdentity.identityKey).toBe(yoursSub.identityKeyHex);

    // Explicit choice 2: User selects 'handcash' -> connects to HandCash Wallet
    const selectedHandCash = createExplicitWalletAdapter('handcash', {
      yoursOptions: { brc100Wallet: yoursSub.walletClient },
      handcashOptions: { brc100Wallet: handcashSub.walletClient },
    });
    const handcashIdentity = await selectedHandCash.connect();
    expect(handcashIdentity.provider).toBe('handcash');
    expect(handcashIdentity.identityKey).toBe(handcashSub.identityKeyHex);

    // Vendor prefix mismatch guard: If HandCash adapter is handed a Yours substrate, it rejects with PROVIDER_MISMATCH
    const mismatchedHandCash = new HandCashWalletAdapter({
      brc100Wallet: yoursSub.walletClient,
    });
    await expect(mismatchedHandCash.connect()).rejects.toMatchObject({
      code: 'PROVIDER_MISMATCH',
    });

    // And if Yours adapter is handed a HandCash substrate, it rejects with PROVIDER_MISMATCH
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

    // Strong secret in production produces Secure + HttpOnly + SameSite=lax cookies
    const adapter = new MockWalletAdapter({ persona: 'alice' });
    const conn = await adapter.connect();
    const prodService = new WalletAuthService({
      prisma,
      sessionSecret: 'prod-9f8e7d6c5b4a3928172635445566778899aabbccddeeff',
      envSource: { NODE_ENV: 'production', APP_MODE: 'live' },
    });

    const challenge = await prodService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });
    const sig = await adapter.signChallenge(challenge.challengeText);
    const authRes = await prodService.verifyChallengeAndAuthenticate({
      challengeId: challenge.id,
      provider: 'mock',
      publicKey: sig.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
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
      provider: 'handcash',
      domain: appDomain,
    });
    const sigMismatch = await handcashAdapter.signChallenge(
      challengeMismatch.challengeText
    );
    await expect(
      mainnetAuthService.verifyChallengeAndAuthenticate({
        challengeId: challengeMismatch.id,
        provider: 'handcash',
        publicKey: sigMismatch.publicKey,
        identityKey: hcConn.identityKey,
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
      provider: 'handcash',
      domain: appDomain,
    });
    const sigValid = await handcashAdapter.signChallenge(
      challengeValid.challengeText
    );
    const verified = await mainnetAuthService.verifyChallengeAndAuthenticate({
      challengeId: challengeValid.id,
      provider: 'handcash',
      publicKey: sigValid.publicKey,
      identityKey: hcConn.identityKey,
      signature: sigValid.signature,
      ...(sigValid.keyID ? { keyID: sigValid.keyID } : {}),
      expectedDomain: appDomain,
    });
    expect(verified.activeWallet.network).toBe('main');
    expect(verified.activeWallet.payoutScript).toBeNull();
  });
});
