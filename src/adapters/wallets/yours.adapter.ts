import { WalletClient, type WalletInterface } from '@bsv/sdk';
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

/**
 * Injected `window.yours` browser extension interface (Yours Wallet extension).
 */
export interface YoursInjectedExtension {
  isReady?: boolean;
  connect: () => Promise<string | { identityPubKey?: string } | void>;
  disconnect?: () => Promise<void>;
  getPubKeys: () => Promise<{
    identityPubKey: string;
    ordPubKey?: string;
    bsvPubKey?: string;
  }>;
  getAddresses?: () => Promise<{
    bsvAddress?: string;
    ordAddress?: string;
    identityAddress?: string;
  }>;
  signMessage: (args: {
    message: string;
    encoding?: 'utf8' | 'hex' | 'base64';
  }) => Promise<{
    signedMessage: {
      message: string;
      sig: string;
      address?: string;
    };
  } | {
    sig: string;
    address?: string;
  }>;
  getNetwork?: () => Promise<'mainnet' | 'testnet' | 'main' | 'test'>;
}

export interface YoursWalletAdapterOptions {
  /** Optional explicit BRC-100 WalletInterface (e.g., window.CWI or test substrate) */
  brc100Wallet?: WalletInterface;
  /** Optional explicit window.yours injected extension object */
  injectedExtension?: YoursInjectedExtension;
  /** Originator domain passed to BRC-100 WalletClient */
  originator?: string;
}

function getBrowserYoursExtension(): YoursInjectedExtension | undefined {
  if (typeof globalThis === 'undefined') {
    return undefined;
  }
  const win = globalThis as unknown as {
    yours?: YoursInjectedExtension;
  };
  return win.yours;
}

function hasBrowserWindowCWI(): boolean {
  if (typeof globalThis === 'undefined') {
    return false;
  }
  const win = globalThis as unknown as {
    CWI?: unknown;
  };
  return typeof win.CWI === 'object' && win.CWI !== null;
}

function isYoursCompatibleVersion(version: string): boolean {
  const lower = version.trim().toLowerCase();
  if (lower.startsWith('handcash')) {
    return false;
  }
  return (
    lower.startsWith('yours') ||
    lower.startsWith('1sat') ||
    lower.startsWith('babbage') ||
    lower.startsWith('cwi')
  );
}

/**
 * YoursWalletAdapter
 *
 * Implements explicit discovery and authentication for Yours Wallet without
 * automatic provider racing (`WalletClient('auto')` is NEVER used).
 *
 * Supports:
 * 1. BRC-100 `window.CWI` substrate (verified via `getVersion()` vendor prefix to reject HandCash).
 * 2. Injected `window.yours` browser extension (`connect`, `getPubKeys`, `signMessage` BSM).
 */
export class YoursWalletAdapter implements WalletAdapter {
  public readonly provider = 'yours' as const;
  private readonly options: YoursWalletAdapterOptions;
  private activeBrc100Wallet: WalletInterface | null = null;
  private activeExtension: YoursInjectedExtension | null = null;
  private cachedIdentity: WalletIdentity | null = null;

  constructor(options: YoursWalletAdapterOptions = {}) {
    this.options = options;
  }

  public async isAvailable(): Promise<boolean> {
    if (this.options.brc100Wallet) {
      try {
        const { version } = await this.options.brc100Wallet.getVersion({});
        return isYoursCompatibleVersion(version);
      } catch {
        return false;
      }
    }
    if (this.options.injectedExtension || getBrowserYoursExtension()) {
      return true;
    }
    if (hasBrowserWindowCWI()) {
      try {
        const cwiClient = new WalletClient('window.CWI', this.options.originator);
        const { version } = await cwiClient.getVersion({});
        return isYoursCompatibleVersion(version);
      } catch {
        return false;
      }
    }
    return false;
  }

  public async connect(): Promise<WalletConnectionResult> {
    // Path 1: Explicit BRC-100 WalletInterface or browser `window.CWI`
    const candidateBrc100 =
      this.options.brc100Wallet ??
      (hasBrowserWindowCWI()
        ? new WalletClient('window.CWI', this.options.originator)
        : null);

    if (candidateBrc100) {
      try {
        const { version } = await candidateBrc100.getVersion({});
        if (!isYoursCompatibleVersion(version)) {
          throw new WalletConnectionError(
            'yours',
            'PROVIDER_MISMATCH',
            `Explicit Yours Wallet connection refused provider with version "${version}". Please select the matching wallet provider.`
          );
        }

        await candidateBrc100.waitForAuthentication({});
        const { publicKey } = await candidateBrc100.getPublicKey({
          identityKey: true,
        });
        const normalizedPubKey = publicKey.trim().toLowerCase();
        if (!isValidCompressedPublicKey(normalizedPubKey)) {
          throw new WalletConnectionError(
            'yours',
            'AUTHENTICATION_FAILED',
            'Yours Wallet returned an invalid compressed identity public key.'
          );
        }

        const netResult = await candidateBrc100.getNetwork({});
        const network: 'main' | 'test' =
          netResult.network === 'testnet' ? 'test' : 'main';
        const payoutScript = deriveP2PKHScriptFromPublicKey(normalizedPubKey);

        this.activeBrc100Wallet = candidateBrc100;
        this.activeExtension = null;
        this.cachedIdentity = {
          provider: 'yours',
          identityKey: normalizedPubKey,
          publicKey: normalizedPubKey,
          payoutScript,
          network,
          displayName: 'Yours Wallet',
          version,
        };

        return { ...this.cachedIdentity };
      } catch (err) {
        throw this.normalizeError(err);
      }
    }

    // Path 2: Injected `window.yours` extension
    const extension = this.options.injectedExtension ?? getBrowserYoursExtension();
    if (extension) {
      try {
        await extension.connect();
        const pubKeys = await extension.getPubKeys();
        const normalizedIdentityKey = pubKeys.identityPubKey?.trim().toLowerCase();
        if (!normalizedIdentityKey || !isValidCompressedPublicKey(normalizedIdentityKey)) {
          throw new WalletConnectionError(
            'yours',
            'AUTHENTICATION_FAILED',
            'Yours Wallet extension did not return a valid compressed identityPubKey.'
          );
        }

        const signingPubKey = (pubKeys.ordPubKey ?? pubKeys.bsvPubKey ?? normalizedIdentityKey)
          .trim()
          .toLowerCase();
        const payoutKey = isValidCompressedPublicKey(signingPubKey)
          ? signingPubKey
          : normalizedIdentityKey;
        const payoutScript = deriveP2PKHScriptFromPublicKey(payoutKey);

        let network: 'main' | 'test' = 'main';
        if (extension.getNetwork) {
          const rawNet = await extension.getNetwork();
          network = rawNet === 'testnet' || rawNet === 'test' ? 'test' : 'main';
        }

        this.activeExtension = extension;
        this.activeBrc100Wallet = null;
        this.cachedIdentity = {
          provider: 'yours',
          identityKey: normalizedIdentityKey,
          publicKey: normalizedIdentityKey,
          payoutScript,
          network,
          displayName: 'Yours Wallet (Extension)',
          version: 'yours-extension',
        };

        return { ...this.cachedIdentity };
      } catch (err) {
        throw this.normalizeError(err);
      }
    }

    throw new WalletConnectionError(
      'yours',
      'WALLET_NOT_FOUND',
      'Yours Wallet was not detected. Please install or unlock the Yours Wallet browser extension.'
    );
  }

  public async disconnect(): Promise<void> {
    if (this.activeExtension?.disconnect) {
      try {
        await this.activeExtension.disconnect();
      } catch {
        // Ignore extension disconnect cleanup errors
      }
    }
    this.activeBrc100Wallet = null;
    this.activeExtension = null;
    this.cachedIdentity = null;
  }

  public async getIdentity(): Promise<WalletIdentity> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'yours',
        'AUTHENTICATION_FAILED',
        'Yours Wallet is not connected. Call connect() first.'
      );
    }
    return { ...this.cachedIdentity };
  }

  public async signChallenge(challenge: string): Promise<SignatureResult> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'yours',
        'AUTHENTICATION_FAILED',
        'Yours Wallet is not connected. Call connect() first.'
      );
    }
    if (!challenge || challenge.trim().length === 0) {
      throw new WalletConnectionError(
        'yours',
        'AUTHENTICATION_FAILED',
        'Cannot sign an empty authentication challenge.'
      );
    }

    const keyID = extractNonceFromChallenge(challenge) ?? DEFAULT_AUTH_KEY_ID;

    try {
      if (this.activeBrc100Wallet) {
        const messageBytes = Array.from(Buffer.from(challenge, 'utf8'));
        const { signature } = await this.activeBrc100Wallet.createSignature({
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
      }

      if (this.activeExtension) {
        const response = await this.activeExtension.signMessage({
          message: challenge,
          encoding: 'utf8',
        });
        const sig =
          'signedMessage' in response
            ? response.signedMessage.sig
            : response.sig;

        if (!sig) {
          throw new WalletConnectionError(
            'yours',
            'AUTHENTICATION_FAILED',
            'Yours Wallet extension returned an empty signature.'
          );
        }

        return {
          signature: sig,
          publicKey: this.cachedIdentity.publicKey,
          challenge,
          keyID,
          signatureScheme: 'bsm',
        };
      }

      throw new WalletConnectionError(
        'yours',
        'AUTHENTICATION_FAILED',
        'No active Yours Wallet transport available.'
      );
    } catch (err) {
      throw this.normalizeError(err);
    }
  }

  public async sendOutputs(_outputs: PaymentOutput[]): Promise<TransactionResult> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'yours',
        'AUTHENTICATION_FAILED',
        'Yours Wallet is not connected.'
      );
    }
    throw new UnsupportedWalletOperationError(
      'yours',
      'sendOutputs',
      'Multi-output BSV transaction broadcasting is disabled during Phase 2 (Wallet Authentication).'
    );
  }

  public async mintOrdinal(_input: MintOrdinalInput): Promise<MintResult> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'yours',
        'AUTHENTICATION_FAILED',
        'Yours Wallet is not connected.'
      );
    }
    throw new UnsupportedWalletOperationError(
      'yours',
      'mintOrdinal',
      '1Sat Ordinal minting is disabled during Phase 2 (Wallet Authentication).'
    );
  }

  public async getNetwork(): Promise<'main' | 'test'> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'yours',
        'AUTHENTICATION_FAILED',
        'Yours Wallet is not connected.'
      );
    }
    return this.cachedIdentity.network;
  }

  private normalizeError(err: unknown): WalletConnectionError {
    if (err instanceof WalletConnectionError) {
      return err;
    }
    const message =
      err instanceof Error ? err.message : 'Unknown Yours Wallet error';
    const lower = message.toLowerCase();

    if (lower.includes('reject') || lower.includes('denied') || lower.includes('cancel')) {
      return new WalletConnectionError('yours', 'USER_REJECTED', message);
    }
    if (lower.includes('lock')) {
      return new WalletConnectionError('yours', 'WALLET_LOCKED', message);
    }
    if (lower.includes('not found') || lower.includes('no wallet')) {
      return new WalletConnectionError('yours', 'WALLET_NOT_FOUND', message);
    }
    return new WalletConnectionError('yours', 'AUTHENTICATION_FAILED', message);
  }
}
