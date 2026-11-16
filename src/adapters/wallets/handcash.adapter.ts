import {
  HTTPWalletJSON,
  Utils,
  WalletClient,
  type WalletInterface,
} from '@bsv/sdk';
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
  WalletProviderDiscovery,
} from '@/types/wallet';

export const HANDCASH_PRIMARY_BRIDGE_URL = 'https://127.0.0.1:2121';
export const HANDCASH_FALLBACK_BRIDGE_URL = 'http://127.0.0.1:3321';
export const HANDCASH_BRIDGE_ENDPOINTS = [
  HANDCASH_PRIMARY_BRIDGE_URL,
  HANDCASH_FALLBACK_BRIDGE_URL,
] as const;

export interface HandCashWalletAdapterOptions {
  /** Optional explicit BRC-100 WalletInterface substrate for HandCash */
  brc100Wallet?: WalletInterface;
  /** Ordered local bridge endpoints to probe (defaults to https://127.0.0.1:2121 then http://127.0.0.1:3321) */
  endpoints?: string[];
  /** Custom fetch implementation for HTTPWalletJSON requests */
  httpClient?: typeof fetch;
  /** Optional factory override for unit tests constructing per-endpoint BRC-100 clients */
  clientFactory?: (endpoint: string) => WalletInterface;
  /** Originator domain passed to BRC-100 WalletClient */
  originator?: string;
  /** Authoritative BSV network for live minting */
  expectedNetwork?: 'main' | 'test';
  /** Runtime mode passed from client context/server config for 1Sat minting */
  appMode?: 'mock' | 'live';
  /** Test-only gate enabling simulated BRC-100 live mint tests without env vars */
  allowSimulatedLiveMint?: boolean;
  /** Explicit mainnet approval gate */
  allowMainnetMint?: boolean;
  /** Optional 1Sat Stack API base URL */
  apiBaseUrl?: string;
  /** Optional lookup provider for extracting tx outputs if wallet omits AtomicBEEF */
  lookupProvider?: MintTransactionLookupProvider;
  /** Optional env override */
  envSource?: Record<string, string | undefined>;
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
 * Targets the self-custodial HandCash Desktop BRC-100 wallet via @bsv/sdk
 * `WalletClient` over explicit `HTTPWalletJSON` loopback endpoints:
 * - Primary: `https://127.0.0.1:2121`
 * - Fallback: `http://127.0.0.1:3321`
 *
 * Security & Design Constraints:
 * - Does NOT use HandCash Connect cloud OAuth (`HANDCASH_APP_ID` / cloud custody is never used).
 * - Does NOT use `WalletClient('auto')` so it will never race or accidentally connect to a
 *   Yours Wallet browser extension (`window.CWI` / `window.yours`) when both are installed.
 * - Never assumes HandCash's BRC-100 root `identityKey` is its payment key; payment
 *   destinations are derived explicitly via `deriveDestination()` and cryptographically proven.
 *
 * HandCash Mobile Limitation:
 * HandCash Mobile does not run a localhost loopback HTTP bridge reachable by external
 * desktop browsers at `127.0.0.1:2121` or `127.0.0.1:3321`. Mobile wallet support would
 * require a separate remote bridge / WalletConnect-style relay or an in-app mobile webview
 * bridge in a future phase.
 */
export class HandCashWalletAdapter implements WalletAdapter {
  public readonly provider = 'handcash' as const;
  private readonly options: HandCashWalletAdapterOptions;
  private activeWallet: WalletInterface | null = null;
  private connectedEndpoint: string | null = null;
  private cachedIdentity: WalletIdentity | null = null;
  private cachedDestination: VerifiedWalletDestination | null = null;

  constructor(options: HandCashWalletAdapterOptions = {}) {
    this.options = options;
  }

  public getWalletInterface(): WalletInterface | null {
    return this.activeWallet;
  }

  public getConnectedEndpoint(): string | null {
    return this.connectedEndpoint;
  }

  public getCapabilities(): WalletCapabilities {
    const bridgeDetectedOrActive =
      this.activeWallet !== null ||
      this.options.brc100Wallet !== undefined ||
      this.options.clientFactory !== undefined ||
      typeof window !== 'undefined';

    return {
      canAuthenticate: bridgeDetectedOrActive,
      canMintOrdinal: bridgeDetectedOrActive,
      canSendOutputs: false,
      supportsBrc100: bridgeDetectedOrActive,
      connectionTransport: bridgeDetectedOrActive ? 'brc100-http' : 'none',
    };
  }

  private buildClientForEndpoint(endpoint: string): WalletInterface {
    if (this.options.clientFactory) {
      return this.options.clientFactory(endpoint);
    }
    const transport = new HTTPWalletJSON(
      this.options.originator,
      endpoint,
      this.options.httpClient
    );
    return new WalletClient(transport, this.options.originator);
  }

  private getEndpoints(): string[] {
    if (this.options.endpoints && this.options.endpoints.length > 0) {
      return this.options.endpoints;
    }
    return [...HANDCASH_BRIDGE_ENDPOINTS];
  }

  /**
   * Probes HandCash Desktop BRC-100 bridge availability (`https://127.0.0.1:2121`,
   * then `http://127.0.0.1:3321`) without racing other wallet providers.
   */
  public async discoverBridge(): Promise<WalletProviderDiscovery> {
    if (this.options.brc100Wallet) {
      try {
        const { version } = await this.options.brc100Wallet.getVersion({});
        const compatible = isHandCashCompatibleVersion(version);
        return {
          provider: 'handcash',
          displayName: 'HandCash BRC-100 Wallet',
          available: compatible,
          transport: 'brc100-http',
          version,
          capabilities: this.getCapabilities(),
          details: compatible
            ? `HandCash BRC-100 substrate detected (${version}).`
            : `Detected non-HandCash wallet (${version}); rejected by explicit provider check.`,
        };
      } catch (err) {
        return {
          provider: 'handcash',
          displayName: 'HandCash BRC-100 Wallet',
          available: false,
          transport: 'brc100-http',
          details:
            err instanceof Error
              ? err.message
              : 'Injected HandCash BRC-100 wallet did not respond.',
        };
      }
    }

    if (typeof window === 'undefined' && !this.options.clientFactory) {
      return {
        provider: 'handcash',
        displayName: 'HandCash BRC-100 Wallet',
        available: false,
        transport: 'brc100-http',
        details: 'HandCash Desktop bridge detection runs in browser.',
      };
    }

    const endpoints = this.getEndpoints();
    let mismatchVersion: string | undefined;

    for (const endpoint of endpoints) {
      try {
        const candidate = this.buildClientForEndpoint(endpoint);
        const { version } = await candidate.getVersion({});
        if (!isHandCashCompatibleVersion(version)) {
          mismatchVersion = version;
          continue;
        }
        return {
          provider: 'handcash',
          displayName: 'HandCash BRC-100 Wallet',
          available: true,
          transport: 'brc100-http',
          version,
          capabilities: this.getCapabilities(),
          details: `HandCash BRC-100 Desktop bridge detected at ${endpoint} (${version}).`,
        };
      } catch {
        continue;
      }
    }

    return {
      provider: 'handcash',
      displayName: 'HandCash BRC-100 Wallet',
      available: false,
      transport: 'brc100-http',
      details: mismatchVersion
        ? `Local bridge responded with non-HandCash version "${mismatchVersion}". Ensure HandCash Desktop BRC Wallet is running.`
        : `HandCash Desktop BRC-100 bridge not detected at ${endpoints.join(' or ')}.`,
    };
  }

  public async isAvailable(): Promise<boolean> {
    const status = await this.discoverBridge();
    return status.available;
  }

  public async connect(): Promise<WalletConnectionResult> {
    const candidates: Array<{ endpoint: string; wallet: WalletInterface }> = this.options
      .brc100Wallet
      ? [{ endpoint: 'injected-brc100', wallet: this.options.brc100Wallet }]
      : typeof window === 'undefined' && !this.options.clientFactory
        ? []
        : this.getEndpoints().map((endpoint) => ({
            endpoint,
            wallet: this.buildClientForEndpoint(endpoint),
          }));

    if (candidates.length === 0) {
      throw new WalletConnectionError(
        'handcash',
        'WALLET_NOT_FOUND',
        'HandCash Desktop BRC-100 bridge must be connected from the browser (or via an injected BRC-100 substrate).'
      );
    }

    let lastError: WalletConnectionError | null = null;

    for (const { endpoint, wallet } of candidates) {
      try {
        const { version } = await wallet.getVersion({});
        if (!isHandCashCompatibleVersion(version)) {
          throw new WalletConnectionError(
            'handcash',
            'PROVIDER_MISMATCH',
            `Explicit HandCash connection refused non-HandCash wallet provider ("${version}"). Please unlock HandCash Desktop BRC Wallet or select the matching provider.`
          );
        }

        const authResult = await wallet.waitForAuthentication({});
        if (
          (authResult as { authenticated?: boolean } | null)?.authenticated ===
          false
        ) {
          throw new WalletConnectionError(
            'handcash',
            'WALLET_LOCKED',
            'HandCash Desktop BRC Wallet is locked or awaiting login. Unlock HandCash Desktop and try again.'
          );
        }

        const { publicKey } = await wallet.getPublicKey({
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

        const netResult = await wallet.getNetwork({});
        const network = normalizeBsvNetwork(netResult.network);

        // Do NOT silently derive a static P2PKH payout script from HandCash's BRC-100
        // root identityKey. Payment destinations must be explicitly derived and verified.
        this.activeWallet = wallet;
        this.connectedEndpoint = endpoint;
        this.cachedDestination = null;
        const capabilities = this.getCapabilities();
        this.cachedIdentity = {
          provider: 'handcash',
          identityKey: normalizedPubKey,
          publicKey: normalizedPubKey,
          capabilities,
          network,
          displayName: 'HandCash BRC-100 Wallet',
          version,
        };

        return { ...this.cachedIdentity };
      } catch (err) {
        const normalized = this.normalizeError(err);
        lastError = normalized;

        // If the endpoint responded with a hard semantic rejection (wrong wallet, locked,
        // or user rejected prompt), do not silently mask it behind the next endpoint.
        if (
          normalized.code === 'PROVIDER_MISMATCH' ||
          normalized.code === 'USER_REJECTED' ||
          normalized.code === 'WALLET_LOCKED' ||
          this.options.brc100Wallet
        ) {
          this.activeWallet = null;
          this.connectedEndpoint = null;
          this.cachedIdentity = null;
          this.cachedDestination = null;
          throw normalized;
        }
      }
    }

    this.activeWallet = null;
    this.connectedEndpoint = null;
    this.cachedIdentity = null;
    this.cachedDestination = null;
    throw (
      lastError ??
      new WalletConnectionError(
        'handcash',
        'WALLET_NOT_FOUND',
        `HandCash Desktop BRC-100 local bridge was not reachable at ${HANDCASH_PRIMARY_BRIDGE_URL} or ${HANDCASH_FALLBACK_BRIDGE_URL}.`
      )
    );
  }

  public async disconnect(): Promise<void> {
    this.activeWallet = null;
    this.connectedEndpoint = null;
    this.cachedIdentity = null;
    this.cachedDestination = null;
  }

  public async getIdentity(): Promise<WalletIdentity> {
    if (!this.cachedIdentity) {
      throw new WalletConnectionError(
        'handcash',
        'AUTHENTICATION_FAILED',
        'HandCash wallet is not connected. Call connect() first.'
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
    if (!this.activeWallet || !this.cachedIdentity) {
      throw new WalletConnectionError(
        'handcash',
        'AUTHENTICATION_FAILED',
        'HandCash wallet is not connected. Call connect() first.'
      );
    }

    const proof = await deriveAndSignBrc100Destination({
      wallet: this.activeWallet,
      provider: 'handcash',
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
    const messageBytes = Utils.toArray(challenge, 'utf8');

    try {
      const { signature } = await this.activeWallet.createSignature({
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

  public async mintOrdinal(input: MintOrdinalInput): Promise<MintResult> {
    if (!this.activeWallet || !this.cachedIdentity) {
      throw new WalletConnectionError(
        'handcash',
        'AUTHENTICATION_FAILED',
        'HandCash wallet is not connected.'
      );
    }

    const destinationScript =
      input.destinationScript?.trim().toLowerCase() ||
      this.cachedDestination?.lockingScript ||
      (await this.deriveDestination()).lockingScript;

    const minter = new OneSatMintingAdapter({
      wallet: this.activeWallet,
      provider: 'handcash',
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
        'handcash',
        'AUTHENTICATION_FAILED',
        'HandCash wallet is not connected.'
      );
    }
    return this.cachedIdentity.network;
  }

  private normalizeError(err: unknown): WalletConnectionError {
    return normalizeBrc100WalletError(
      'handcash',
      err,
      `HandCash Desktop BRC-100 bridge was not detected at ${HANDCASH_PRIMARY_BRIDGE_URL} or ${HANDCASH_FALLBACK_BRIDGE_URL}. Start and unlock HandCash Desktop BRC Wallet on this machine.`
    );
  }
}
