import { WalletClient, type WalletInterface } from '@bsv/sdk';
import {
  UnsupportedWalletOperationError,
  type WalletAdapter,
  WalletConnectionError,
} from '@/adapters/wallets/wallet-adapter';
import {
  AUTH_BRC100_PROTOCOL_ID,
  DEFAULT_AUTH_KEY_ID,
  extractNonceFromChallenge,
  isValidCompressedPublicKey,
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

export interface HandCashWalletAdapterOptions {
  /** Optional explicit BRC-100 WalletInterface substrate for HandCash */
  brc100Wallet?: WalletInterface;
  /** Explicit BRC-100 substrate type for HandCash local bridge (defaults to 'secure-json-api' / 'json-api') */
  substrate?: 'secure-json-api' | 'json-api' | 'XDM';
  /** Originator domain passed to BRC-100 WalletClient */
  originator?: string;
}

function isHandCashCompatibleVersion(version: string): boolean {
  const lower = version.trim().toLowerCase();
  if (lower.startsWith('yours') || lower.startsWith('1sat')) {
    return false;
  }
  return lower.startsWith('handcash');
}

/**
 * HandCashWalletAdapter
 *
 * Targets the self-custodial HandCash BRC-100 wallet via @bsv/sdk `WalletClient`.
 * Does NOT use the cloud OAuth HandCash Connect SDK (`HANDCASH_APP_ID` is not required).
 * Does NOT use `WalletClient('auto')` so it will never accidentally connect to a
 * Yours Wallet browser extension (`window.CWI` / `window.yours`) when both are installed.
 */
export class HandCashWalletAdapter implements WalletAdapter {
  public readonly provider = 'handcash' as const;
  private readonly options: HandCashWalletAdapterOptions;
  private activeWallet: WalletInterface | null = null;
  private cachedIdentity: WalletIdentity | null = null;

  constructor(options: HandCashWalletAdapterOptions = {}) {
    this.options = options;
  }

  public async isAvailable(): Promise<boolean> {
    const candidate = this.resolveCandidateSubstrate();
    if (!candidate) {
      return false;
    }
    try {
      const { version } = await candidate.getVersion({});
      return isHandCashCompatibleVersion(version);
    } catch {
      return false;
    }
  }

  public async connect(): Promise<WalletConnectionResult> {
    const candidate = this.resolveCandidateSubstrate();
    if (!candidate) {
      throw new WalletConnectionError(
        'handcash',
        'WALLET_NOT_FOUND',
        'HandCash BRC-100 wallet bridge is not available.'
      );
    }

    try {
      const { version } = await candidate.getVersion({});
      if (!isHandCashCompatibleVersion(version)) {
        throw new WalletConnectionError(
          'handcash',
          'PROVIDER_MISMATCH',
          `Explicit HandCash connection refused non-HandCash wallet provider ("${version}"). Please unlock HandCash BRC-100 Wallet or select the matching provider.`
        );
      }

      await candidate.waitForAuthentication({});
      const { publicKey } = await candidate.getPublicKey({
        identityKey: true,
      });

      const normalizedPubKey = publicKey.trim().toLowerCase();
      if (!isValidCompressedPublicKey(normalizedPubKey)) {
        throw new WalletConnectionError(
          'handcash',
          'AUTHENTICATION_FAILED',
          'HandCash BRC-100 wallet returned an invalid compressed identity public key.'
        );
      }

      const netResult = await candidate.getNetwork({});
      const rawNet = String(netResult.network ?? '').toLowerCase();
      const network: 'main' | 'test' =
        rawNet === 'testnet' || rawNet === 'test' ? 'test' : 'main';

      // Do NOT silently derive a static P2PKH payout script from HandCash's BRC-100
      // root identityKey. HandCash payment destinations use protocol-derived keys or
      // handles rather than the raw identityKey, and NFT ownership payout routing is
      // determined strictly by the verified on-chain locking script of the NFT output.
      this.activeWallet = candidate;
      this.cachedIdentity = {
        provider: 'handcash',
        identityKey: normalizedPubKey,
        publicKey: normalizedPubKey,
        network,
        displayName: 'HandCash BRC-100 Wallet',
        version,
      };

      return { ...this.cachedIdentity };
    } catch (err) {
      this.activeWallet = null;
      this.cachedIdentity = null;
      throw this.normalizeError(err);
    }
  }

  public async disconnect(): Promise<void> {
    this.activeWallet = null;
    this.cachedIdentity = null;
  }

  public async getIdentity(): Promise<WalletIdentity> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'handcash',
        'AUTHENTICATION_FAILED',
        'HandCash wallet is not connected. Call connect() first.'
      );
    }
    return { ...this.cachedIdentity };
  }

  public async signChallenge(challenge: string): Promise<SignatureResult> {
    if (!this.activeWallet || !this.cachedIdentity) {
      throw new WalletConnectionError(
        'handcash',
        'AUTHENTICATION_FAILED',
        'HandCash wallet is not connected. Call connect() first.'
      );
    }
    if (!challenge || challenge.trim().length === 0) {
      throw new WalletConnectionError(
        'handcash',
        'AUTHENTICATION_FAILED',
        'Cannot sign an empty authentication challenge.'
      );
    }

    const keyID = extractNonceFromChallenge(challenge) ?? DEFAULT_AUTH_KEY_ID;
    const messageBytes = Array.from(Buffer.from(challenge, 'utf8'));

    try {
      const { signature } = await this.activeWallet.createSignature({
        data: messageBytes,
        protocolID: AUTH_BRC100_PROTOCOL_ID,
        keyID,
        counterparty: 'anyone',
      });

      return {
        signature: Buffer.from(signature).toString('hex').toLowerCase(),
        publicKey: this.cachedIdentity.publicKey,
        challenge,
        keyID,
        signatureScheme: 'brc100',
      };
    } catch (err) {
      throw this.normalizeError(err);
    }
  }

  public async sendOutputs(_outputs: PaymentOutput[]): Promise<TransactionResult> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'handcash',
        'AUTHENTICATION_FAILED',
        'HandCash wallet is not connected.'
      );
    }
    throw new UnsupportedWalletOperationError(
      'handcash',
      'sendOutputs',
      'Multi-output BSV transaction broadcasting is disabled until Phase 5 (Revenue Distribution).'
    );
  }

  public async mintOrdinal(_input: MintOrdinalInput): Promise<MintResult> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'handcash',
        'AUTHENTICATION_FAILED',
        'HandCash wallet is not connected.'
      );
    }
    throw new UnsupportedWalletOperationError(
      'handcash',
      'mintOrdinal',
      'Direct 1Sat Ordinal inscription minting is not supported by the HandCash BRC-100 bridge without an external 1Sat funding provider.'
    );
  }

  public async getNetwork(): Promise<'main' | 'test'> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'handcash',
        'AUTHENTICATION_FAILED',
        'HandCash wallet is not connected.'
      );
    }
    return this.cachedIdentity.network;
  }

  private resolveCandidateSubstrate(): WalletInterface | null {
    if (this.options.brc100Wallet) {
      return this.options.brc100Wallet;
    }
    if (typeof globalThis === 'undefined' || typeof window === 'undefined') {
      return null;
    }
    const substrateType = this.options.substrate ?? 'secure-json-api';
    return new WalletClient(substrateType, this.options.originator);
  }

  private normalizeError(err: unknown): WalletConnectionError {
    if (err instanceof WalletConnectionError) {
      return err;
    }
    const message =
      err instanceof Error ? err.message : 'Unknown HandCash BRC-100 wallet error';
    const lower = message.toLowerCase();

    if (lower.includes('reject') || lower.includes('denied') || lower.includes('cancel')) {
      return new WalletConnectionError('handcash', 'USER_REJECTED', message);
    }
    if (lower.includes('lock')) {
      return new WalletConnectionError('handcash', 'WALLET_LOCKED', message);
    }
    if (
      lower.includes('fetch') ||
      lower.includes('econnrefused') ||
      lower.includes('timed out') ||
      lower.includes('no wallet')
    ) {
      return new WalletConnectionError(
        'handcash',
        'WALLET_NOT_FOUND',
        `HandCash BRC-100 local bridge is unreachable (${message}). Ensure HandCash Desktop / BRC-100 bridge is running.`
      );
    }
    return new WalletConnectionError('handcash', 'AUTHENTICATION_FAILED', message);
  }
}
