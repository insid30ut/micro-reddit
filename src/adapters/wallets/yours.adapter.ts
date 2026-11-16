import type { InscribeRequest, InscribeResponse, OneSatContext } from '@1sat/actions';
import { PublicKey, WalletClient, Utils, type WalletInterface } from '@bsv/sdk';
import type { MintTransactionLookupProvider } from '@/adapters/ordinals/minting-adapter';
import { OneSatMintingAdapter } from '@/adapters/ordinals/onesat-minting.adapter';
import {
  deriveAndSignBrc100Destination,
  normalizeBrc100WalletError,
  normalizeBsvNetwork,
} from '@/adapters/wallets/brc100-shared';
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
  verifyWalletChallengeSignature,
} from '@/lib/auth/crypto-verify';
import type {
  MintOrdinalInput,
  MintResult,
  PaymentOutput,
  SignatureResult,
  TransactionResult,
  VerifiedWalletDestination,
  WalletCapabilities,
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
  /** Optional explicit window.yours injected extension object (authentication-only fallback) */
  injectedExtension?: YoursInjectedExtension;
  /** Originator domain passed to BRC-100 WalletClient */
  originator?: string;
  /** Prefer legacy window.yours even when window.CWI exists (mostly for testing fallback behavior) */
  preferLegacyExtension?: boolean;
  /** Runtime mode passed from client context/server config for 1Sat minting */
  appMode?: 'mock' | 'live';
  /** Authoritative BSV network for live minting */
  expectedNetwork?: 'main' | 'test';
  /** Test-only gate enabling simulated BRC-100 live mint tests without env vars */
  allowSimulatedLiveMint?: boolean;
  /** Explicit mainnet approval gate */
  allowMainnetMint?: boolean;
  /** Optional 1Sat Stack API base URL */
  apiBaseUrl?: string;
  /** Optional lookup provider for extracting tx outputs if wallet omits AtomicBEEF */
  lookupProvider?: MintTransactionLookupProvider;
  /** Optional override for @1sat/actions inscribe.execute in unit tests */
  customInscribeAction?: (
    ctx: OneSatContext,
    input: InscribeRequest
  ) => Promise<InscribeResponse>;
  /** Optional env override */
  envSource?: Record<string, string | undefined>;
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
  if (typeof window === 'undefined' || window === null) {
    return false;
  }
  const win = window as unknown as {
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
 * Implements explicit discovery, authentication, key derivation, and 1Sat Ordinal
 * minting for Yours Wallet without automatic provider racing (`WalletClient('auto')`
 * is NEVER used).
 *
 * Note on `@1sat/react` (`WalletProvider` / `useWallet`):
 * The official `@1sat/react` `WalletProvider` delegates connection to `@1sat/connect`'s
 * `connectWallet()`, which calls `new WalletClient('auto')` and races `window.CWI` against
 * loopback HandCash ports (`127.0.0.1:2121` / `127.0.0.1:3321`). Because this application
 * prohibits automatic multi-wallet racing and requires explicit user provider selection, we
 * implement `AppWalletProvider` (`src/context/wallet-context.tsx`) using explicit
 * `YoursWalletAdapter` / `HandCashWalletAdapter` instances while calling `@1sat/actions`
 * (`createContext` + `inscribe.execute`) directly over the active BRC-100 `WalletInterface`.
 *
 * Supports:
 * 1. Primary: BRC-100 `window.CWI` substrate (`new WalletClient('window.CWI', originator)`),
 *    supporting authentication (`canAuthenticate`), derived destination proofs, and 1Sat
 *    Ordinal minting (`canMintOrdinal: true`). Rejects HandCash (`PROVIDER_MISMATCH`).
 * 2. Compatibility Fallback: Injected legacy `window.yours` extension (`connect`, `getPubKeys`,
 *    `signMessage` BSM), strictly marked as authentication-only (`canMintOrdinal: false`).
 */
export class YoursWalletAdapter implements WalletAdapter {
  public readonly provider = 'yours' as const;
  private readonly options: YoursWalletAdapterOptions;
  private activeBrc100Wallet: WalletInterface | null = null;
  private activeExtension: YoursInjectedExtension | null = null;
  private extensionPubKeys: {
    identityPubKey: string;
    bsvPubKey?: string;
    ordPubKey?: string;
  } | null = null;
  private cachedIdentity: WalletIdentity | null = null;
  private cachedDestination: VerifiedWalletDestination | null = null;

  constructor(options: YoursWalletAdapterOptions = {}) {
    this.options = options;
  }

  public getWalletInterface(): WalletInterface | null {
    return this.activeBrc100Wallet;
  }

  public getCapabilities(): WalletCapabilities {
    if (this.activeBrc100Wallet) {
      return {
        canAuthenticate: true,
        canMintOrdinal: true,
        canSendOutputs: false,
        supportsBrc100: true,
        connectionTransport: 'brc100-cwi',
      };
    }
    if (this.activeExtension) {
      return {
        canAuthenticate: true,
        canMintOrdinal: false,
        canSendOutputs: false,
        supportsBrc100: false,
        connectionTransport: 'legacy-yours',
      };
    }
    if (
      !this.options.preferLegacyExtension &&
      (this.options.brc100Wallet || hasBrowserWindowCWI())
    ) {
      return {
        canAuthenticate: true,
        canMintOrdinal: true,
        canSendOutputs: false,
        supportsBrc100: true,
        connectionTransport: 'brc100-cwi',
      };
    }
    if (this.options.injectedExtension || getBrowserYoursExtension()) {
      return {
        canAuthenticate: true,
        canMintOrdinal: false,
        canSendOutputs: false,
        supportsBrc100: false,
        connectionTransport: 'legacy-yours',
      };
    }
    return {
      canAuthenticate: false,
      canMintOrdinal: false,
      canSendOutputs: false,
      supportsBrc100: false,
      connectionTransport: 'none',
    };
  }

  public async isAvailable(): Promise<boolean> {
    if (!this.options.preferLegacyExtension && this.options.brc100Wallet) {
      try {
        const { version } = await this.options.brc100Wallet.getVersion({});
        return isYoursCompatibleVersion(version);
      } catch {
        return false;
      }
    }
    if (!this.options.preferLegacyExtension && hasBrowserWindowCWI()) {
      try {
        const cwiClient = new WalletClient('window.CWI', this.options.originator);
        const { version } = await cwiClient.getVersion({});
        return isYoursCompatibleVersion(version);
      } catch {
        // Check legacy window.yours below if CWI probe fails
      }
    }
    if (this.options.injectedExtension || getBrowserYoursExtension()) {
      return true;
    }
    return false;
  }

  public async connect(): Promise<WalletConnectionResult> {
    // Path 1: Explicit BRC-100 WalletInterface or browser `window.CWI`
    const candidateBrc100 =
      this.options.preferLegacyExtension
        ? null
        : (this.options.brc100Wallet ??
          (hasBrowserWindowCWI()
            ? new WalletClient('window.CWI', this.options.originator)
            : null));

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

        const authRes = await candidateBrc100.waitForAuthentication({});
        if (
          (authRes as { authenticated?: boolean } | null)?.authenticated ===
          false
        ) {
          throw new WalletConnectionError(
            'yours',
            'WALLET_LOCKED',
            'Yours Wallet BRC-100 interface is locked or unauthenticated.'
          );
        }

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
        const network = normalizeBsvNetwork(netResult.network);

        // Do NOT silently derive a payout destination from the BRC-100 root identityKey.
        // Call `deriveDestination()` explicitly to derive and cryptographically prove a payment key.
        this.activeBrc100Wallet = candidateBrc100;
        this.activeExtension = null;
        this.extensionPubKeys = null;
        this.cachedDestination = null;
        const capabilities = this.getCapabilities();
        this.cachedIdentity = {
          provider: 'yours',
          identityKey: normalizedPubKey,
          publicKey: normalizedPubKey,
          capabilities,
          network,
          displayName: 'Yours Wallet',
          version,
        };

        return { ...this.cachedIdentity };
      } catch (err) {
        const normalizedErr = this.normalizeError(err);
        if (
          this.options.brc100Wallet ||
          normalizedErr.code !== 'WALLET_NOT_FOUND'
        ) {
          this.activeBrc100Wallet = null;
          this.activeExtension = null;
          this.extensionPubKeys = null;
          this.cachedIdentity = null;
          this.cachedDestination = null;
          throw normalizedErr;
        }
      }
    }

    // Path 2: Legacy Injected `window.yours` extension (authentication-only fallback)
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

        const normalizedBsvKey = pubKeys.bsvPubKey?.trim().toLowerCase();
        const normalizedOrdKey = pubKeys.ordPubKey?.trim().toLowerCase();

        let network: 'main' | 'test' = 'test';
        if (extension.getNetwork) {
          network = normalizeBsvNetwork(await extension.getNetwork());
        }

        // Legacy window.yours extension cannot sign a derived BRC-100 payment-key proof;
        // mark capabilities clearly as authentication-only (canMintOrdinal: false) and do not
        // attach an unverified payoutScript.
        this.activeExtension = extension;
        this.activeBrc100Wallet = null;
        this.extensionPubKeys = {
          identityPubKey: normalizedIdentityKey,
          ...(normalizedBsvKey && isValidCompressedPublicKey(normalizedBsvKey)
            ? { bsvPubKey: normalizedBsvKey }
            : {}),
          ...(normalizedOrdKey && isValidCompressedPublicKey(normalizedOrdKey)
            ? { ordPubKey: normalizedOrdKey }
            : {}),
        };
        this.cachedDestination = null;
        const capabilities = this.getCapabilities();
        this.cachedIdentity = {
          provider: 'yours',
          identityKey: normalizedIdentityKey,
          publicKey: normalizedIdentityKey,
          capabilities,
          network,
          displayName: 'Yours Wallet (Legacy Extension)',
          version: 'yours-extension',
        };

        return { ...this.cachedIdentity };
      } catch (err) {
        this.activeBrc100Wallet = null;
        this.activeExtension = null;
        this.extensionPubKeys = null;
        this.cachedIdentity = null;
        this.cachedDestination = null;
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
    this.extensionPubKeys = null;
    this.cachedIdentity = null;
    this.cachedDestination = null;
  }

  public async getIdentity(): Promise<WalletIdentity> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'yours',
        'AUTHENTICATION_FAILED',
        'Yours Wallet is not connected. Call connect() first.'
      );
    }
    return {
      ...this.cachedIdentity,
      capabilities: this.getCapabilities(),
    };
  }

  public async deriveDestination(options?: {
    keyID?: string;
  }): Promise<VerifiedWalletDestination> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'yours',
        'AUTHENTICATION_FAILED',
        'Yours Wallet is not connected. Call connect() first.'
      );
    }

    if (!this.activeBrc100Wallet) {
      throw new UnsupportedWalletOperationError(
        'yours',
        'deriveDestination',
        'Yours Wallet connected via legacy window.yours extension is authentication-only and cannot cryptographically prove a derived BRC-100 payment destination. Enable BRC-100 window.CWI support in Yours Wallet.'
      );
    }

    const proof = await deriveAndSignBrc100Destination({
      wallet: this.activeBrc100Wallet,
      provider: 'yours',
      identityKey: this.cachedIdentity.identityKey,
      network: this.cachedIdentity.network,
      ...(options?.keyID ? { keyID: options.keyID } : {}),
    });

    this.cachedDestination = proof;
    this.cachedIdentity = {
      ...this.cachedIdentity,
      payoutScript: proof.lockingScript,
      destinationProof: proof,
    };

    return proof;
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
        const messageBytes = Utils.toArray(challenge, 'utf8');
        const { signature } = await this.activeBrc100Wallet.createSignature({
          data: messageBytes,
          protocolID: AUTH_BRC100_PROTOCOL_ID,
          keyID,
          counterparty: 'anyone',
        });

        return {
          signature: Utils.toHex(Array.from(signature)).toLowerCase(),
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
        const signerAddress =
          'signedMessage' in response
            ? response.signedMessage.address
            : response.address;

        if (!sig) {
          throw new WalletConnectionError(
            'yours',
            'AUTHENTICATION_FAILED',
            'Yours Wallet extension returned an empty signature.'
          );
        }

        const candidateKeys = Array.from(
          new Set(
            [
              this.cachedIdentity.identityKey,
              this.cachedIdentity.publicKey,
              this.extensionPubKeys?.identityPubKey,
              this.extensionPubKeys?.bsvPubKey,
              this.extensionPubKeys?.ordPubKey,
            ]
              .map((k) => k?.trim().toLowerCase())
              .filter(
                (k): k is string => Boolean(k && isValidCompressedPublicKey(k))
              )
          )
        );

        let verifiedSigningKey: string | null = null;
        for (const candidatePubKey of candidateKeys) {
          if (signerAddress) {
            try {
              const pubObj = PublicKey.fromString(candidatePubKey);
              const mainnetAddr = pubObj.toAddress('mainnet');
              const testnetAddr = pubObj.toAddress('testnet');
              if (
                signerAddress !== mainnetAddr &&
                signerAddress !== testnetAddr
              ) {
                continue;
              }
            } catch {
              continue;
            }
          }

          const matches = await verifyWalletChallengeSignature({
            challenge,
            signature: sig,
            publicKey: candidatePubKey,
            keyID,
            signatureScheme: 'bsm',
          });
          if (matches) {
            verifiedSigningKey = candidatePubKey;
            break;
          }
        }

        if (!verifiedSigningKey) {
          throw new WalletConnectionError(
            'yours',
            'AUTHENTICATION_FAILED',
            'Yours Wallet extension returned a BSM signature that does not verify against any public key reported by getPubKeys().'
          );
        }

        if (
          verifiedSigningKey !== this.cachedIdentity.publicKey ||
          verifiedSigningKey !== this.cachedIdentity.identityKey
        ) {
          this.cachedIdentity = {
            ...this.cachedIdentity,
            identityKey: verifiedSigningKey,
            publicKey: verifiedSigningKey,
          };
        }

        return {
          signature: sig,
          publicKey: verifiedSigningKey,
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
      'Multi-output BSV transaction broadcasting is disabled until Phase 5 (Revenue Distribution).'
    );
  }

  public async mintOrdinal(input: MintOrdinalInput): Promise<MintResult> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'yours',
        'AUTHENTICATION_FAILED',
        'Yours Wallet is not connected.'
      );
    }
    if (!this.activeBrc100Wallet) {
      throw new UnsupportedWalletOperationError(
        'yours',
        'mintOrdinal',
        'Yours Wallet connected via legacy window.yours extension supports authentication only. Connect via the Yours BRC-100 (window.CWI) interface to mint 1Sat Ordinals.'
      );
    }

    const destinationScript =
      input.destinationScript?.trim().toLowerCase() ||
      this.cachedDestination?.lockingScript ||
      (await this.deriveDestination()).lockingScript;

    const minter = new OneSatMintingAdapter({
      wallet: this.activeBrc100Wallet,
      provider: 'yours',
      // Server-enforced network: if the wallet reports a different network, the minting
      // adapter rejects with NETWORK_MISMATCH before anything is signed or broadcast.
      network: this.options.expectedNetwork ?? this.cachedIdentity.network,
      ...(this.options.appMode ? { appMode: this.options.appMode } : {}),
      ...(this.options.allowSimulatedLiveMint !== undefined
        ? { allowSimulatedLiveMint: this.options.allowSimulatedLiveMint }
        : {}),
      ...(this.options.allowMainnetMint !== undefined
        ? { allowMainnetMint: this.options.allowMainnetMint }
        : {}),
      ...(this.options.apiBaseUrl ? { apiBaseUrl: this.options.apiBaseUrl } : {}),
      ...(this.options.lookupProvider ? { lookupProvider: this.options.lookupProvider } : {}),
      ...(this.options.customInscribeAction
        ? { customInscribeAction: this.options.customInscribeAction }
        : {}),
      ...(this.options.envSource ? { envSource: this.options.envSource } : {}),
    });

    const minted = await minter.mintCommunityOrdinal({
      communityId: input.metadata.communityId,
      name: input.metadata.name,
      description: input.metadata.description ?? `${input.metadata.name} Community`,
      artworkUrl: input.metadata.artworkUrl ?? null,
      destinationP2PKHScript: destinationScript,
      network: this.cachedIdentity.network,
    });

    return {
      txid: minted.txid,
      vout: minted.vout,
      origin: minted.origin,
      lockingScript: minted.rawOutputScriptHex,
      isMock: minted.isMock,
    };
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
    return normalizeBrc100WalletError(
      'yours',
      err,
      'Yours Wallet extension / window.CWI is not reachable.'
    );
  }
}
