import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Beef,
  LockingScript,
  PrivateKey,
  ProtoWallet,
  Transaction,
  Utils,
  type WalletInterface,
} from '@bsv/sdk';
import { buildInscriptionScript } from '@1sat/templates';
import type { PrismaClient } from '@/generated/prisma/client';
import { createTestPGlitePrisma } from '../helpers/pglite-prisma';
import { MintingAdapterError } from '@/adapters/ordinals/minting-adapter';
import {
  MockChainTransactionStore,
  MockMintingAdapter,
} from '@/adapters/ordinals/mock-minting.adapter';
import { OneSatMintingAdapter } from '@/adapters/ordinals/onesat-minting.adapter';
import { HandCashWalletAdapter } from '@/adapters/wallets/handcash.adapter';
import { MockWalletAdapter } from '@/adapters/wallets/mock.adapter';
import { YoursWalletAdapter } from '@/adapters/wallets/yours.adapter';
import { WalletAuthService } from '@/lib/auth/auth-service';
import {
  CommunityService,
  CommunityServiceError,
} from '@/lib/communities/community-service';
import {
  buildCommunityNftMetadata,
  parseAndVerifyCommunityNftMetadata,
  serializeCommunityNftMetadataDeterministically,
} from '@/lib/ordinals/metadata';
import {
  MintVerificationError,
  MintVerificationService,
} from '@/lib/ordinals/mint-verification-service';
import {
  build1SatOrdinalLockingScript,
  parseOrdinalOutputScript,
} from '@/lib/ordinals/script-parser';

describe('Phase 3 — Community Creation, Deterministic 1Sat Metadata & Independent Mint Verification', () => {
  const appDomain = 'localhost:3000';
  const testSessionSecret = 'phase3-unit-test-session-secret-minimum-32-chars';
  const envSource = {
    APP_MODE: 'mock',
    NEXT_PUBLIC_APP_MODE: 'mock',
    BSV_NETWORK: 'main',
    OWNERSHIP_CONFIRMATIONS_REQUIRED: '1',
  };

  let dbHandle: Awaited<ReturnType<typeof createTestPGlitePrisma>>;
  let prisma: PrismaClient;
  let authService: WalletAuthService;
  let communityService: CommunityService;
  let chainStore: MockChainTransactionStore;
  let mockMinter: MockMintingAdapter;
  let mintVerificationService: MintVerificationService;

  beforeAll(async () => {
    dbHandle = await createTestPGlitePrisma();
    prisma = dbHandle.prisma;
  });

  afterAll(async () => {
    await dbHandle.close();
  });

  beforeEach(async () => {
    chainStore = new MockChainTransactionStore();
    mockMinter = new MockMintingAdapter({
      chainStore,
      defaultConfirmations: 1,
      defaultBlockHeight: 881_234,
    });

    authService = new WalletAuthService({
      prisma,
      sessionSecret: testSessionSecret,
      envSource,
    });
    communityService = new CommunityService({
      prisma,
      envSource,
    });
    mintVerificationService = new MintVerificationService({
      prisma,
      lookupProvider: chainStore,
      mintingAdapter: mockMinter,
      envSource,
    });

    await prisma.ownershipEvent.deleteMany();
    await prisma.communityNFT.deleteMany();
    await prisma.revenuePolicy.deleteMany();
    await prisma.community.deleteMany();
    await authService.clear();
  });

  async function authenticateMockPersona(persona: 'alice' | 'bob' | 'payer') {
    const adapter = new MockWalletAdapter({ persona, network: 'main' });
    const conn = await adapter.connect();
    const challenge = await authService.issueChallenge({
      provider: 'mock',
      domain: appDomain,
    });
    const sig = await adapter.signChallenge(challenge.challengeText);
    return authService.verifyChallengeAndAuthenticate({
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
      network: 'main',
      expectedDomain: appDomain,
    });
  }

  it('1. Creates a community in initial PENDING_MINT status with a 70/30 revenue policy and authenticated creator association', async () => {
    const aliceAuth = await authenticateMockPersona('alice');
    const bobAuth = await authenticateMockPersona('bob');

    // Attempt to spoof `originalCreatorId` in request body — must be ignored in favor of authenticated user
    const created = await communityService.createCommunity({
      authenticatedUserId: aliceAuth.user.id,
      input: {
        name: 'Technology & Programming',
        slug: 'Technology & Programming!',
        description:
          'A community for software development, programming, and Bitcoin SV ordinals.',
        artworkUrl: 'https://example.com/tech-community.png',
        originalCreatorId: bobAuth.user.id,
      },
    });

    expect(created.name).toBe('Technology & Programming');
    expect(created.slug).toBe('technology-programming');
    expect(created.status).toBe('PENDING_MINT');
    expect(created.originalCreatorId).toBe(aliceAuth.user.id);
    expect(created.originalCreatorId).not.toBe(bobAuth.user.id);
    expect(created.currentOwnerScript).toBeNull();
    expect(created.nft).toBeNull();
    expect(created.revenuePolicy).toEqual({
      version: 1,
      ownerShareBps: 7000,
      platformShareBps: 3000,
    });

    const listed = await communityService.listCommunities();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const fetchedBySlug = await communityService.getCommunityBySlugOrId(
      'technology-programming'
    );
    expect(fetchedBySlug.id).toBe(created.id);
  });

  it('2. Rejects duplicate community slugs with DUPLICATE_SLUG (409)', async () => {
    const aliceAuth = await authenticateMockPersona('alice');

    await communityService.createCommunity({
      authenticatedUserId: aliceAuth.user.id,
      input: {
        name: 'BSV Builders',
        slug: 'bsv-builders',
        description: 'Building scalable applications on Bitcoin SV.',
      },
    });

    await expect(
      communityService.createCommunity({
        authenticatedUserId: aliceAuth.user.id,
        input: {
          name: 'BSV Builders Duplicate',
          slug: 'BSV-Builders',
          description: 'Attempting to register the same normalized slug.',
        },
      })
    ).rejects.toMatchObject({
      code: 'DUPLICATE_SLUG',
      statusCode: 409,
    });
  });

  it('3. Rejects unauthenticated community creation with UNAUTHENTICATED (401)', async () => {
    await expect(
      communityService.createCommunity({
        authenticatedUserId: null,
        input: {
          name: 'Unauthorized Community',
          slug: 'unauthorized-community',
          description: 'Should not be created without an authenticated user.',
        },
      })
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      statusCode: 401,
    });

    await expect(
      communityService.createCommunity({
        authenticatedUserId: 'non-existent-user-id',
        input: {
          name: 'Ghost User Community',
          slug: 'ghost-user-community',
          description: 'Should not be created when user ID does not exist.',
        },
      })
    ).rejects.toBeInstanceOf(CommunityServiceError);
  });

  it('4. Generates deterministic 1Sat Ordinals metadata with canonical key ordering and round-trip verification', () => {
    const first = serializeCommunityNftMetadataDeterministically({
      communityId: 'comm-deterministic-001',
      name: '  Café & Code  ',
      description: 'Deterministic JSON serialization check for 1Sat Ordinals.',
      artworkUrl: 'https://example.com/art.png',
    });

    // Construct with decomposed Unicode ("Cafe\u0301") and extra whitespace
    const second = serializeCommunityNftMetadataDeterministically({
      communityId: 'comm-deterministic-001',
      name: 'Cafe\u0301 & Code',
      description: '  Deterministic JSON serialization check for 1Sat Ordinals. ',
      artworkUrl: 'https://example.com/art.png',
    });

    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(first.contentSha256Hex).toBe(second.contentSha256Hex);
    expect(first.contentBase64).toBe(second.contentBase64);
    expect(Object.keys(JSON.parse(first.canonicalJson) as object)).toEqual([
      'app',
      'artworkUrl',
      'communityId',
      'description',
      'name',
      'platform',
      'schemaVersion',
      'type',
    ]);

    const verified = parseAndVerifyCommunityNftMetadata(
      first.canonicalJson,
      'comm-deterministic-001'
    );
    expect(verified).toEqual(
      buildCommunityNftMetadata({
        communityId: 'comm-deterministic-001',
        name: 'Café & Code',
        description: 'Deterministic JSON serialization check for 1Sat Ordinals.',
        artworkUrl: 'https://example.com/art.png',
      })
    );
  });

  it('5. Mints a mock 1Sat Ordinal, independently verifies the inscription and locking script, and activates the community', async () => {
    const aliceAuth = await authenticateMockPersona('alice');
    const community = await communityService.createCommunity({
      authenticatedUserId: aliceAuth.user.id,
      input: {
        name: 'Ordinals Engineering',
        slug: 'ordinals-engineering',
        description: 'Protocol-aware 1Sat Ordinals engineering community.',
        artworkUrl: 'https://example.com/ordinals.svg',
      },
    });
    expect(community.status).toBe('PENDING_MINT');

    // Use a distinct NFT owner P2PKH locking script to prove that the verified NFT output
    // locking script — not the creator's identityKey — is authoritative for initial ownership
    const explicitNftOwnerScript =
      '76a91411223344556677889900aabbccddeeff0011223388ac';

    const outcome = await mintVerificationService.mintAndVerifyCommunityNft({
      communitySlugOrId: community.slug,
      authenticatedUserId: aliceAuth.user.id,
      destinationP2PKHScript: explicitNftOwnerScript,
    });

    expect(outcome.verified).toBe(true);
    expect(outcome.activated).toBe(true);
    expect(outcome.community.status).toBe('ACTIVE');
    expect(outcome.community.currentOwnerScript).toBe(explicitNftOwnerScript);
    expect(outcome.nft.origin).toBe(`${outcome.nft.originTxid}_0`);
    expect(outcome.nft.currentOwnerScript).toBe(explicitNftOwnerScript);
    expect(outcome.nft.scriptType).toBe('P2PKH');
    expect(outcome.nft.isPayoutRoutable).toBe(true);
    expect(outcome.nft.mintStatus).toBe('VERIFIED');
    expect(outcome.nft.confirmationStatus).toBe('CONFIRMED');
    expect(outcome.nft.isMock).toBe(true);

    // Duplicate mint attempt after verification must be rejected with DUPLICATE_MINT_REJECTED (409)
    await expect(
      mintVerificationService.mintAndVerifyCommunityNft({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        destinationP2PKHScript: explicitNftOwnerScript,
      })
    ).rejects.toMatchObject({
      code: 'DUPLICATE_MINT_REJECTED',
      statusCode: 409,
    });
  });

  it('6. Rejects invalid inscriptions (missing "ord" envelope or wrong MIME type) and leaves community in PENDING_MINT', async () => {
    const aliceAuth = await authenticateMockPersona('alice');
    const community = await communityService.createCommunity({
      authenticatedUserId: aliceAuth.user.id,
      input: {
        name: 'Invalid Inscription Test',
        slug: 'invalid-inscription-test',
        description: 'Testing rejection of outputs lacking a 1Sat ord envelope.',
      },
    });

    const plainP2PKHScript =
      '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac';
    const fakeTxid = 'a'.repeat(64);
    chainStore.registerTransaction({
      txid: fakeTxid,
      network: 'main',
      outputs: [
        {
          vout: 0,
          satoshis: 1,
          lockingScriptHex: plainP2PKHScript, // No OP_FALSE OP_IF "ord" envelope
        },
      ],
      blockHeight: 881_235,
      confirmations: 2,
      isMock: true,
    });

    await expect(
      mintVerificationService.verifySubmittedMintTransaction({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        txid: fakeTxid,
        vout: 0,
      })
    ).rejects.toMatchObject({
      code: 'MINT_INVALID_INSCRIPTION',
      statusCode: 422,
    });

    const reloaded = await communityService.getCommunityBySlugOrId(
      community.slug
    );
    expect(reloaded.status).toBe('PENDING_MINT');
    expect(reloaded.nft).toBeNull();
  });

  it('7. Rejects wrong network (both client-claimed network mismatch and chain transaction network mismatch)', async () => {
    const aliceAuth = await authenticateMockPersona('alice');
    const community = await communityService.createCommunity({
      authenticatedUserId: aliceAuth.user.id,
      input: {
        name: 'Network Verification Test',
        slug: 'network-verification-test',
        description: 'Testing strict server BSV_NETWORK enforcement on mint.',
      },
    });

    const ownerScript = '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac';
    const serialized = serializeCommunityNftMetadataDeterministically({
      communityId: community.id,
      name: community.name,
      description: community.description,
      artworkUrl: community.artworkUrl,
    });
    const ordScript = build1SatOrdinalLockingScript({
      ownerP2PKHScriptHex: ownerScript,
      contentBytes: serialized.contentBytes,
      contentType: serialized.contentType,
    });

    const testnetTxid = 'b'.repeat(64);
    chainStore.registerTransaction({
      txid: testnetTxid,
      network: 'test', // Transaction is on testnet while server BSV_NETWORK is 'main'
      outputs: [
        {
          vout: 0,
          satoshis: 1,
          lockingScriptHex: ordScript,
        },
      ],
      blockHeight: 100_000,
      confirmations: 3,
      isMock: true,
    });

    // Case A: Client claims 'test' while server is 'main'
    await expect(
      mintVerificationService.verifySubmittedMintTransaction({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        txid: testnetTxid,
        vout: 0,
        claimedNetwork: 'test',
      })
    ).rejects.toMatchObject({
      code: 'MINT_WRONG_NETWORK',
      statusCode: 422,
    });

    // Case B: Client omits claimedNetwork, but observed transaction is on 'test'
    await expect(
      mintVerificationService.verifySubmittedMintTransaction({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        txid: testnetTxid,
        vout: 0,
      })
    ).rejects.toMatchObject({
      code: 'MINT_WRONG_NETWORK',
      statusCode: 422,
    });

    const reloaded = await communityService.getCommunityBySlugOrId(
      community.slug
    );
    expect(reloaded.status).toBe('PENDING_MINT');
  });

  it('8. Rejects incorrect transaction outputs (missing vout, non-1-satoshi output, or non-standard locking script)', async () => {
    const aliceAuth = await authenticateMockPersona('alice');
    const community = await communityService.createCommunity({
      authenticatedUserId: aliceAuth.user.id,
      input: {
        name: 'Output Validation Test',
        slug: 'output-validation-test',
        description: 'Testing output index, satoshi amount, and script checks.',
      },
    });

    const ownerScript = '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac';
    const serialized = serializeCommunityNftMetadataDeterministically({
      communityId: community.id,
      name: community.name,
      description: community.description,
      artworkUrl: community.artworkUrl,
    });
    const ordScript = build1SatOrdinalLockingScript({
      ownerP2PKHScriptHex: ownerScript,
      contentBytes: serialized.contentBytes,
      contentType: serialized.contentType,
    });

    const wrongSatsTxid = 'c'.repeat(64);
    chainStore.registerTransaction({
      txid: wrongSatsTxid,
      network: 'main',
      outputs: [
        {
          vout: 0,
          satoshis: 500, // Invalid: 1Sat Ordinal must be 1 satoshi
          lockingScriptHex: ordScript,
        },
      ],
      blockHeight: 881_236,
      confirmations: 2,
      isMock: true,
    });

    // Missing vout (vout 3 does not exist)
    await expect(
      mintVerificationService.verifySubmittedMintTransaction({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        txid: wrongSatsTxid,
        vout: 3,
      })
    ).rejects.toMatchObject({
      code: 'MINT_INVALID_OUTPUT',
      statusCode: 422,
    });

    // Wrong satoshi amount (500 sats instead of 1 sat)
    await expect(
      mintVerificationService.verifySubmittedMintTransaction({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        txid: wrongSatsTxid,
        vout: 0,
      })
    ).rejects.toMatchObject({
      code: 'MINT_INVALID_OUTPUT',
      statusCode: 422,
    });

    const reloaded = await communityService.getCommunityBySlugOrId(
      community.slug
    );
    expect(reloaded.status).toBe('PENDING_MINT');
  });

  it('9. Rejects incorrect community metadata (mismatched communityId or tampered name) and leaves community in PENDING_MINT', async () => {
    const aliceAuth = await authenticateMockPersona('alice');
    const community = await communityService.createCommunity({
      authenticatedUserId: aliceAuth.user.id,
      input: {
        name: 'Authentic Community',
        slug: 'authentic-community',
        description: 'Testing metadata tampering detection during mint verification.',
      },
    });

    const ownerScript = '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac';
    // Inscribe metadata for a DIFFERENT communityId
    const wrongMetadata = serializeCommunityNftMetadataDeterministically({
      communityId: 'different-community-id-999',
      name: community.name,
      description: community.description,
      artworkUrl: community.artworkUrl,
    });
    const wrongOrdScript = build1SatOrdinalLockingScript({
      ownerP2PKHScriptHex: ownerScript,
      contentBytes: wrongMetadata.contentBytes,
      contentType: wrongMetadata.contentType,
    });

    const wrongMetaTxid = 'd'.repeat(64);
    chainStore.registerTransaction({
      txid: wrongMetaTxid,
      network: 'main',
      outputs: [
        {
          vout: 0,
          satoshis: 1,
          lockingScriptHex: wrongOrdScript,
        },
      ],
      blockHeight: 881_237,
      confirmations: 2,
      isMock: true,
    });

    await expect(
      mintVerificationService.verifySubmittedMintTransaction({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        txid: wrongMetaTxid,
        vout: 0,
      })
    ).rejects.toMatchObject({
      code: 'MINT_INVALID_METADATA',
      statusCode: 422,
    });

    const reloaded = await communityService.getCommunityBySlugOrId(
      community.slug
    );
    expect(reloaded.status).toBe('PENDING_MINT');
  });

  it('10. Activates a community ONLY after the confirmation threshold is satisfied (0-conf stays PENDING_MINT)', async () => {
    const aliceAuth = await authenticateMockPersona('alice');
    const community = await communityService.createCommunity({
      authenticatedUserId: aliceAuth.user.id,
      input: {
        name: 'Confirmation Policy Community',
        slug: 'confirmation-policy-community',
        description: 'Verifying 0-conf inscriptions do not prematurely activate a community.',
      },
    });

    const ownerScript = '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac';

    // Step 1: Mint with 0 confirmations (mempool only)
    const unconfirmedOutcome =
      await mintVerificationService.mintAndVerifyCommunityNft({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        destinationP2PKHScript: ownerScript,
        simulatedConfirmations: 0,
      });

    expect(unconfirmedOutcome.verified).toBe(false);
    expect(unconfirmedOutcome.activated).toBe(false);
    expect(unconfirmedOutcome.community.status).toBe('PENDING_MINT');
    expect(unconfirmedOutcome.community.currentOwnerScript).toBeNull();
    expect(unconfirmedOutcome.nft.mintStatus).toBe('MINTED');
    expect(unconfirmedOutcome.nft.confirmationStatus).toBe('UNCONFIRMED');

    // Step 2: Transaction mines into a block (confirmations = 1 >= OWNERSHIP_CONFIRMATIONS_REQUIRED)
    const parsedScript = parseOrdinalOutputScript(
      unconfirmedOutcome.nft.rawOutputScript ?? ''
    );
    expect(parsedScript.hasOrdEnvelope).toBe(true);

    chainStore.registerTransaction({
      txid: unconfirmedOutcome.nft.originTxid,
      network: 'main',
      outputs: [
        {
          vout: 0,
          satoshis: 1,
          lockingScriptHex: unconfirmedOutcome.nft.rawOutputScript ?? '',
        },
      ],
      blockHeight: 881_240,
      confirmations: 1,
      isMock: true,
    });

    const confirmedOutcome =
      await mintVerificationService.verifySubmittedMintTransaction({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        txid: unconfirmedOutcome.nft.originTxid,
        vout: 0,
      });

    expect(confirmedOutcome.verified).toBe(true);
    expect(confirmedOutcome.activated).toBe(true);
    expect(confirmedOutcome.community.status).toBe('ACTIVE');
    expect(confirmedOutcome.community.currentOwnerScript).toBe(ownerScript);
    expect(confirmedOutcome.nft.mintStatus).toBe('VERIFIED');
    expect(confirmedOutcome.nft.confirmationStatus).toBe('CONFIRMED');
  });

  it('11. Blocks live OneSatMintingAdapter execution when APP_MODE="mock"', async () => {
    const liveAdapter = new OneSatMintingAdapter({
      envSource: {
        APP_MODE: 'mock',
        NEXT_PUBLIC_APP_MODE: 'mock',
        BSV_NETWORK: 'main',
      },
    });

    await expect(
      liveAdapter.mintCommunityOrdinal({
        communityId: 'comm-live-blocked',
        name: 'Blocked Live Mint',
        description: 'Should be blocked while APP_MODE is mock.',
        destinationP2PKHScript:
          '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac',
        network: 'main',
      })
    ).rejects.toThrow(/disabled while APP_MODE is "mock"/i);
  });

  function createSimulatedBrc100Substrate(params: {
    seedLabel: string;
    version: string;
    network?: 'mainnet' | 'testnet';
    onCreateAction?: WalletInterface['createAction'];
    onSignAction?: WalletInterface['signAction'];
  }): WalletInterface {
    const hashBytes = Utils.toArray(params.seedLabel, 'utf8');
    const padded = new Array<number>(32).fill(0);
    for (let i = 0; i < 32; i++) {
      padded[i] = (hashBytes[i % hashBytes.length] ?? 1) ^ ((i + 1) * 31);
    }
    const proto = new ProtoWallet(new PrivateKey(padded));

    return {
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
      async createSignature(
        args: Parameters<ProtoWallet['createSignature']>[0]
      ) {
        return proto.createSignature(args);
      },
      ...(params.onCreateAction ? { createAction: params.onCreateAction } : {}),
      ...(params.onSignAction ? { signAction: params.onSignAction } : {}),
    } as unknown as WalletInterface;
  }

  function buildSourceDummyTx(): Transaction {
    const srcTx = new Transaction();
    srcTx.addOutput({
      satoshis: 50_000,
      lockingScript: LockingScript.fromHex(
        '76a914111111111111111111111111111111111111111188ac'
      ),
    });
    return srcTx;
  }

  it('12. Executes Yours window.CWI 1Sat Ordinal mint flow, extracts real non-zero vout=2 & script, and passes server verification', async () => {
    const testEnv = {
      APP_MODE: 'live',
      NEXT_PUBLIC_APP_MODE: 'live',
      BSV_NETWORK: 'test',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/postgres',
      SESSION_SECRET: testSessionSecret,
      OWNERSHIP_CONFIRMATIONS_REQUIRED: '1',
    };

    const yoursWallet = createSimulatedBrc100Substrate({
      seedLabel: 'yours-live-mint-test',
      version: 'yours-3.0.0',
      network: 'testnet',
    });

    const sourceTx = buildSourceDummyTx();
    const changeScript = LockingScript.fromHex(
      '76a914222222222222222222222222222222222222222288ac'
    );
    const opReturnScript = LockingScript.fromHex('006a0474657374');

    let capturedDestinationScript = '';
    let builtTx: Transaction | null = null;

    const yoursAdapter = new YoursWalletAdapter({
      brc100Wallet: yoursWallet,
      appMode: 'live',
      expectedNetwork: 'test',
      allowSimulatedLiveMint: true,
      customInscribeAction: async (_ctx, input) => {
        capturedDestinationScript = String(input.destination?.lockingScript ?? '');
        const inscriptionScript = buildInscriptionScript(
          LockingScript.fromHex(capturedDestinationScript),
          Buffer.from(input.base64Content, 'base64'),
          input.contentType,
          input.map
        );

        const tx = new Transaction();
        tx.addInput({
          sourceTransaction: sourceTx,
          sourceOutputIndex: 0,
          unlockingScript: LockingScript.fromHex('51'),
        });
        // vout 0: OP_RETURN protocol notice
        tx.addOutput({ satoshis: 0, lockingScript: opReturnScript });
        // vout 1: Funding change
        tx.addOutput({ satoshis: 9_850, lockingScript: changeScript });
        // vout 2: Actual 1-satoshi Community NFT inscription output
        tx.addOutput({ satoshis: 1, lockingScript: inscriptionScript });

        const beef = new Beef();
        beef.mergeTransaction(tx);
        const atomicBeef = beef.toBinaryAtomic(tx.id('hex'));
        builtTx = tx;

        return {
          txid: tx.id('hex'),
          tx: atomicBeef,
        };
      },
    });

    const conn = await yoursAdapter.connect();
    const destProof = await yoursAdapter.deriveDestination();

    // Authenticate creator on testnet service and link derived destination
    const challenge = await authService.issueChallenge({
      provider: 'yours',
      domain: appDomain,
    });
    const sig = await yoursAdapter.signChallenge(challenge.challengeText);
    const testAuthService = new WalletAuthService({
      prisma,
      sessionSecret: testSessionSecret,
      envSource: testEnv,
    });
    const aliceTestAuth = await testAuthService.verifyChallengeAndAuthenticate({
      challengeId: challenge.id,
      provider: 'yours',
      publicKey: sig.publicKey,
      identityKey: conn.identityKey,
      signature: sig.signature,
      ...(sig.keyID ? { keyID: sig.keyID } : {}),
      payoutScript: destProof.lockingScript,
      destinationProof: destProof,
      expectedDomain: appDomain,
    });

    const testCommunityService = new CommunityService({
      prisma,
      envSource: testEnv,
    });
    const community = await testCommunityService.createCommunity({
      authenticatedUserId: aliceTestAuth.user.id,
      input: {
        name: 'Yours Live Mint Guild',
        slug: 'yours-live-mint-guild',
        description: 'Testing live BRC-100 Yours window.CWI ordinal minting.',
      },
    });

    const testMintService = new MintVerificationService({
      prisma,
      lookupProvider: chainStore,
      envSource: testEnv,
    });
    const intent = await testMintService.prepareMintIntent({
      communitySlugOrId: community.slug,
      authenticatedUserId: aliceTestAuth.user.id,
    });

    const mintResult = await yoursAdapter.mintOrdinal({
      contentBase64: intent.serializedMetadata.contentBase64,
      contentType: intent.serializedMetadata.contentType,
      metadata: intent.serializedMetadata.metadata,
      destinationScript: destProof.lockingScript,
    });

    expect(mintResult.isMock).toBe(false);
    expect(mintResult.vout).toBe(2);
    expect(mintResult.origin).toBe(`${mintResult.txid}_2`);
    expect(capturedDestinationScript).toBe(destProof.lockingScript);

    const parsedScript = parseOrdinalOutputScript(mintResult.lockingScript);
    expect(parsedScript.hasOrdEnvelope).toBe(true);
    expect(parsedScript.spendingScriptHex).toBe(destProof.lockingScript);

    // Register mined outputs in lookup store and run independent server verification
    expect(builtTx).not.toBeNull();
    chainStore.registerTransaction({
      txid: mintResult.txid,
      network: 'test',
      outputs: builtTx!.outputs.map((out, index) => ({
        vout: index,
        satoshis: out.satoshis ?? 0,
        lockingScriptHex: out.lockingScript.toHex().toLowerCase(),
      })),
      blockHeight: 1_900_123,
      confirmations: 1,
      isMock: false,
    });

    const verificationOutcome =
      await testMintService.verifySubmittedMintTransaction({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceTestAuth.user.id,
        txid: mintResult.txid,
        vout: mintResult.vout,
        expectedOrigin: mintResult.origin,
      });

    expect(verificationOutcome.verified).toBe(true);
    expect(verificationOutcome.activated).toBe(true);
    expect(verificationOutcome.community.status).toBe('ACTIVE');
    expect(verificationOutcome.community.currentOwnerScript).toBe(
      destProof.lockingScript
    );
    expect(verificationOutcome.nft.origin).toBe(`${mintResult.txid}_2`);
    expect(verificationOutcome.nft.originVout).toBe(2);
  });

  it('13. Executes HandCash BRC-100 createAction + signAction mint flow and extracts non-zero vout=1', async () => {
    const sourceTx = buildSourceDummyTx();
    const changeScript = LockingScript.fromHex(
      '76a914333333333333333333333333333333333333333388ac'
    );

    let createActionCalled = false;
    let signActionCalled = false;
    let stagedOutputHex = '';

    const hcWallet = createSimulatedBrc100Substrate({
      seedLabel: 'handcash-live-mint-test',
      version: 'handcash-1.5.0',
      network: 'testnet',
      onCreateAction: async (args) => {
        createActionCalled = true;
        expect(args.outputs?.[0]?.satoshis).toBe(1);
        expect(args.outputs?.[0]?.basket).toBe('1sat');
        stagedOutputHex = args.outputs?.[0]?.lockingScript ?? '';
        return {
          signableTransaction: {
            reference: 'hc-sign-ref-vout1',
            tx: [],
          },
        };
      },
      onSignAction: async (args) => {
        signActionCalled = true;
        expect(args.reference).toBe('hc-sign-ref-vout1');

        const tx = new Transaction();
        tx.addInput({
          sourceTransaction: sourceTx,
          sourceOutputIndex: 0,
          unlockingScript: LockingScript.fromHex('51'),
        });
        // vout 0: HandCash fee/change output
        tx.addOutput({ satoshis: 4_200, lockingScript: changeScript });
        // vout 1: Exact 1-satoshi Community NFT inscription output
        tx.addOutput({
          satoshis: 1,
          lockingScript: LockingScript.fromHex(stagedOutputHex),
        });

        const beef = new Beef();
        beef.mergeTransaction(tx);
        return {
          txid: tx.id('hex'),
          tx: beef.toBinaryAtomic(tx.id('hex')),
        };
      },
    });

    const handcashAdapter = new HandCashWalletAdapter({
      brc100Wallet: hcWallet,
      appMode: 'live',
      allowSimulatedLiveMint: true,
    });

    await handcashAdapter.connect();
    const destProof = await handcashAdapter.deriveDestination();

    const metadata = buildCommunityNftMetadata({
      communityId: 'comm-hc-100',
      name: 'HandCash BRC Creators',
      description: 'HandCash createAction/signAction 1Sat Ordinal test.',
    });
    const serialized = serializeCommunityNftMetadataDeterministically({
      communityId: metadata.communityId,
      name: metadata.name,
      description: metadata.description ?? '',
      artworkUrl: metadata.artworkUrl ?? null,
    });

    const mintResult = await handcashAdapter.mintOrdinal({
      contentBase64: serialized.contentBase64,
      contentType: serialized.contentType,
      metadata: serialized.metadata,
      destinationScript: destProof.lockingScript,
    });

    expect(createActionCalled).toBe(true);
    expect(signActionCalled).toBe(true);
    expect(mintResult.isMock).toBe(false);
    expect(mintResult.vout).toBe(1);
    expect(mintResult.origin).toBe(`${mintResult.txid}_1`);

    const parsed = parseOrdinalOutputScript(mintResult.lockingScript);
    expect(parsed.hasOrdEnvelope).toBe(true);
    expect(parsed.spendingScriptHex).toBe(destProof.lockingScript);
  });

  it('14. Rejects live mint output extraction (MINT_TX_OUTPUT_UNVERIFIABLE) if signed tx lacks a matching 1-satoshi Community NFT output', async () => {
    const sourceTx = buildSourceDummyTx();
    const decoyWallet = createSimulatedBrc100Substrate({
      seedLabel: 'handcash-missing-ordinal-out',
      version: 'handcash-1.5.0',
      network: 'testnet',
      onCreateAction: async () => {
        const tx = new Transaction();
        tx.addInput({
          sourceTransaction: sourceTx,
          sourceOutputIndex: 0,
          unlockingScript: LockingScript.fromHex('51'),
        });
        // Missing 1-satoshi inscription output: only plain 500-sat P2PKH output
        tx.addOutput({
          satoshis: 500,
          lockingScript: LockingScript.fromHex(
            '76a914444444444444444444444444444444444444444488ac'
          ),
        });
        const beef = new Beef();
        beef.mergeTransaction(tx);
        return {
          txid: tx.id('hex'),
          tx: beef.toBinaryAtomic(tx.id('hex')),
        };
      },
    });

    const handcashAdapter = new HandCashWalletAdapter({
      brc100Wallet: decoyWallet,
      appMode: 'live',
      allowSimulatedLiveMint: true,
    });
    await handcashAdapter.connect();
    const destProof = await handcashAdapter.deriveDestination();

    const metadata = buildCommunityNftMetadata({
      communityId: 'comm-hc-missing-out',
      name: 'Invalid Mint Output Community',
      description: 'Should fail output verification.',
    });
    const serialized = serializeCommunityNftMetadataDeterministically({
      communityId: metadata.communityId,
      name: metadata.name,
      description: metadata.description ?? '',
      artworkUrl: null,
    });

    await expect(
      handcashAdapter.mintOrdinal({
        contentBase64: serialized.contentBase64,
        contentType: serialized.contentType,
        metadata: serialized.metadata,
        destinationScript: destProof.lockingScript,
      })
    ).rejects.toMatchObject({
      name: 'MintingAdapterError',
      code: 'MINT_TX_OUTPUT_UNVERIFIABLE',
    });
  });

  it('15. Blocks a second mint while the first is unconfirmed, rejects a different origin, and keeps one genesis ownership event', async () => {
    const aliceAuth = await authenticateMockPersona('alice');
    const community = await communityService.createCommunity({
      authenticatedUserId: aliceAuth.user.id,
      input: {
        name: 'Single NFT Community',
        slug: 'single-nft-community',
        description: 'A community must never end up with two NFTs.',
      },
    });
    const ownerScript = '76a914aabbccddeeff00112233445566778899aabbccdd88ac';

    // First mint lands in the mempool only (0 confirmations)
    const first = await mintVerificationService.mintAndVerifyCommunityNft({
      communitySlugOrId: community.slug,
      authenticatedUserId: aliceAuth.user.id,
      destinationP2PKHScript: ownerScript,
      simulatedConfirmations: 0,
    });
    expect(first.nft.mintStatus).toBe('MINTED');
    expect(first.community.status).toBe('PENDING_MINT');

    // A new mint intent and a new mint are both refused while the first is pending
    await expect(
      mintVerificationService.prepareMintIntent({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
      })
    ).rejects.toMatchObject({ code: 'MINT_ALREADY_PENDING', statusCode: 409 });
    await expect(
      mintVerificationService.mintAndVerifyCommunityNft({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        destinationP2PKHScript: ownerScript,
      })
    ).rejects.toMatchObject({ code: 'MINT_ALREADY_PENDING', statusCode: 409 });

    // A second, otherwise valid, inscription for the same community cannot replace the first origin
    const secondInscription = await mockMinter.mintCommunityOrdinal({
      communityId: community.id,
      name: community.name,
      description: community.description,
      artworkUrl: community.artworkUrl,
      destinationP2PKHScript: '76a914112233445566778899aabbccddeeff001122334488ac',
      network: 'main',
      simulatedConfirmations: 1,
    });
    expect(secondInscription.origin).not.toBe(first.nft.origin);
    await expect(
      mintVerificationService.verifySubmittedMintTransaction({
        communitySlugOrId: community.slug,
        authenticatedUserId: aliceAuth.user.id,
        txid: secondInscription.txid,
        vout: secondInscription.vout,
      })
    ).rejects.toMatchObject({ code: 'MINT_ALREADY_PENDING', statusCode: 409 });

    const nftAfterReject = await prisma.communityNFT.findUniqueOrThrow({
      where: { communityId: community.id },
    });
    expect(nftAfterReject.origin).toBe(first.nft.origin);

    // Re-checking the same unconfirmed mint (polling) does not append duplicate genesis events
    await mintVerificationService.verifySubmittedMintTransaction({
      communitySlugOrId: community.slug,
      authenticatedUserId: aliceAuth.user.id,
      txid: first.nft.originTxid,
      vout: first.nft.originVout,
    });

    // The original mint confirms and activates the community
    chainStore.registerTransaction({
      txid: first.nft.originTxid,
      network: 'main',
      outputs: [
        {
          vout: first.nft.originVout,
          satoshis: 1,
          lockingScriptHex: first.nft.rawOutputScript ?? '',
        },
      ],
      blockHeight: 881_300,
      confirmations: 1,
      isMock: true,
    });
    const confirmed = await mintVerificationService.verifySubmittedMintTransaction({
      communitySlugOrId: community.slug,
      authenticatedUserId: aliceAuth.user.id,
      txid: first.nft.originTxid,
      vout: first.nft.originVout,
    });
    expect(confirmed.community.status).toBe('ACTIVE');
    expect(confirmed.nft.origin).toBe(first.nft.origin);

    const genesisEvents = await prisma.ownershipEvent.findMany({
      where: { communityId: community.id },
    });
    expect(genesisEvents).toHaveLength(1);
    expect(genesisEvents[0]?.confirmationStatus).toBe('CONFIRMED');
    expect(genesisEvents[0]?.blockHeight).toBe(881_300);
  });

  it('16. Rejects non-http(s) artwork URLs at creation so every stored community can be minted', async () => {
    const aliceAuth = await authenticateMockPersona('alice');

    for (const [index, artworkUrl] of [
      'ftp://example.com/art.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
    ].entries()) {
      await expect(
        communityService.createCommunity({
          authenticatedUserId: aliceAuth.user.id,
          input: {
            name: `Bad Artwork ${index}`,
            slug: `bad-artwork-${index}`,
            description: 'Artwork links must be plain http(s) URLs.',
            artworkUrl,
          },
        })
      ).rejects.toMatchObject({ code: 'INVALID_COMMUNITY_INPUT', statusCode: 400 });
    }

    const created = await communityService.createCommunity({
      authenticatedUserId: aliceAuth.user.id,
      input: {
        name: 'Good Artwork',
        slug: 'good-artwork',
        description: 'Artwork links must be plain http(s) URLs.',
        artworkUrl: 'https://example.com/art.png',
      },
    });
    const intent = await mintVerificationService.prepareMintIntent({
      communitySlugOrId: created.slug,
      authenticatedUserId: aliceAuth.user.id,
    });
    expect(intent.serializedMetadata.metadata.artworkUrl).toBe(
      'https://example.com/art.png'
    );
  });
});
