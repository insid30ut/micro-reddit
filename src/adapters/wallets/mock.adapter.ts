import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { MockMintingAdapter } from '@/adapters/ordinals/mock-minting.adapter';
import {
  UnsupportedWalletOperationError,
  type WalletAdapter,
  WalletConnectionError,
} from '@/adapters/wallets/wallet-adapter';
import {
  AUTH_BRC100_PROTOCOL_ID,
  DEFAULT_AUTH_KEY_ID,
  deriveP2PKHScriptFromPublicKey,
  extractNonceFromChallenge,
} from '@/lib/auth/crypto-verify';
import type {
  MintOrdinalInput,
  MintResult,
  PaymentOutput,
  SignatureResult,
  TransactionResult,
  WalletConnectionResult,
  WalletIdentity,
} from '@/types/wallet';

export type MockPersonaId = 'alice' | 'bob' | 'payer';

interface MockPersonaSeed {
  id: MockPersonaId;
  displayName: string;
  /** Deterministic 32-byte hex seed used strictly for offline mock testing */
  seedHex: string;
}

const MOCK_PERSONAS: Record<MockPersonaId, MockPersonaSeed> = {
  alice: {
    id: 'alice',
    displayName: 'Alice (Mock Creator)',
    seedHex: '00000000000000000000000000000000000000000000000000000000000000a1',
  },
  bob: {
    id: 'bob',
    displayName: 'Bob (Mock Recipient)',
    seedHex: '00000000000000000000000000000000000000000000000000000000000000b2',
  },
  payer: {
    id: 'payer',
    displayName: 'Charlie (Mock Payer)',
    seedHex: '00000000000000000000000000000000000000000000000000000000000000c3',
  },
};

export interface MockWalletAdapterOptions {
  persona?: MockPersonaId;
  network?: 'main' | 'test';
  shouldRejectConnect?: boolean;
  shouldRejectSign?: boolean;
}

/**
 * Deterministic MockWalletAdapter for Phase 2 authentication and automated testing.
 * Uses real @bsv/sdk PrivateKey and ProtoWallet for cryptographic BRC-100 signatures
 * without ever connecting to or broadcasting on the live BSV network.
 */
export class MockWalletAdapter implements WalletAdapter {
  public readonly provider = 'mock' as const;
  private readonly persona: MockPersonaSeed;
  private readonly privateKey: PrivateKey;
  private readonly protoWallet: ProtoWallet;
  private readonly network: 'main' | 'test';
  private readonly shouldRejectConnect: boolean;
  private readonly shouldRejectSign: boolean;
  private connected = false;

  constructor(options: MockWalletAdapterOptions = {}) {
    const personaId = options.persona ?? 'alice';
    this.persona = MOCK_PERSONAS[personaId];
    this.privateKey = PrivateKey.fromHex(this.persona.seedHex);
    this.protoWallet = new ProtoWallet(this.privateKey);
    this.network = options.network ?? 'main';
    this.shouldRejectConnect = options.shouldRejectConnect ?? false;
    this.shouldRejectSign = options.shouldRejectSign ?? false;
  }

  public async isAvailable(): Promise<boolean> {
    return true;
  }

  public async connect(): Promise<WalletConnectionResult> {
    if (this.shouldRejectConnect) {
      throw new WalletConnectionError(
        'mock',
        'USER_REJECTED',
        'User rejected mock wallet connection.'
      );
    }

    const { publicKey } = await this.protoWallet.getPublicKey({
      identityKey: true,
    });
    const normalizedPubKey = publicKey.toLowerCase();
    const payoutScript = deriveP2PKHScriptFromPublicKey(normalizedPubKey);

    this.connected = true;

    return {
      provider: 'mock',
      identityKey: normalizedPubKey,
      publicKey: normalizedPubKey,
      payoutScript,
      network: this.network,
      displayName: this.persona.displayName,
      version: `mock-1.0.0-${this.persona.id}`,
    };
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
  }

  public async getIdentity(): Promise<WalletIdentity> {
    this.ensureConnected();
    const { publicKey } = await this.protoWallet.getPublicKey({
      identityKey: true,
    });
    const normalizedPubKey = publicKey.toLowerCase();
    return {
      provider: 'mock',
      identityKey: normalizedPubKey,
      publicKey: normalizedPubKey,
      payoutScript: deriveP2PKHScriptFromPublicKey(normalizedPubKey),
      network: this.network,
      displayName: this.persona.displayName,
      version: `mock-1.0.0-${this.persona.id}`,
    };
  }

  public async signChallenge(challenge: string): Promise<SignatureResult> {
    this.ensureConnected();
    if (this.shouldRejectSign) {
      throw new WalletConnectionError(
        'mock',
        'USER_REJECTED',
        'User rejected challenge signature request.'
      );
    }
    if (!challenge || challenge.trim().length === 0) {
      throw new WalletConnectionError(
        'mock',
        'AUTHENTICATION_FAILED',
        'Cannot sign an empty authentication challenge.'
      );
    }

    const { publicKey } = await this.protoWallet.getPublicKey({
      identityKey: true,
    });
    const keyID = extractNonceFromChallenge(challenge) ?? DEFAULT_AUTH_KEY_ID;
    const messageBytes = Array.from(Buffer.from(challenge, 'utf8'));

    const { signature } = await this.protoWallet.createSignature({
      data: messageBytes,
      protocolID: AUTH_BRC100_PROTOCOL_ID,
      keyID,
      counterparty: 'anyone',
    });

    return {
      signature: Buffer.from(signature).toString('hex').toLowerCase(),
      publicKey: publicKey.toLowerCase(),
      challenge,
      keyID,
      signatureScheme: 'brc100',
    };
  }

  public async sendOutputs(_outputs: PaymentOutput[]): Promise<TransactionResult> {
    this.ensureConnected();
    throw new UnsupportedWalletOperationError(
      'mock',
      'sendOutputs',
      'Payment transaction construction and broadcasting are disabled until Phase 5 (Revenue Distribution).'
    );
  }

  public async mintOrdinal(input: MintOrdinalInput): Promise<MintResult> {
    this.ensureConnected();
    const identity = await this.getIdentity();
    const destinationP2PKHScript =
      input.destinationScript ??
      identity.payoutScript ??
      deriveP2PKHScriptFromPublicKey(identity.publicKey);

    const mockMinter = new MockMintingAdapter();
    const minted = await mockMinter.mintCommunityOrdinal({
      communityId: input.metadata.communityId,
      name: input.metadata.name,
      description: input.metadata.description ?? `${input.metadata.name} Community`,
      artworkUrl: input.metadata.artworkUrl ?? null,
      destinationP2PKHScript,
      network: this.network,
    });

    return {
      txid: minted.txid,
      vout: minted.vout,
      origin: minted.origin,
      lockingScript: minted.rawOutputScriptHex,
      isMock: true,
    };
  }

  public async getNetwork(): Promise<'main' | 'test'> {
    this.ensureConnected();
    return this.network;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new WalletConnectionError(
        'mock',
        'AUTHENTICATION_FAILED',
        'Mock wallet is not connected. Call connect() first.'
      );
    }
  }
}
