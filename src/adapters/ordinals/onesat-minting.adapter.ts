import {
  createContext,
  inscribe,
  type InscribeRequest,
  type InscribeResponse,
  type OneSatContext,
} from '@1sat/actions';
import { OneSatServices } from '@1sat/client';
import { buildInscriptionScript } from '@1sat/templates';
import {
  Beef,
  LockingScript,
  Transaction,
  type WalletInterface,
} from '@bsv/sdk';
import {
  MintingAdapterError,
  type MintCommunityOrdinalRequest,
  type MintCommunityOrdinalResult,
  type MintTransactionLookupProvider,
  type ObservedChainTransaction,
  type ObservedChainTransactionOutput,
  type OrdinalMintingAdapter,
} from '@/adapters/ordinals/minting-adapter';
import {
  DEFAULT_DESTINATION_KEY_ID,
  DESTINATION_BRC100_PROTOCOL_ID,
} from '@/lib/auth/crypto-verify';
import { assertLiveModeAuthorized, parseAppEnv } from '@/lib/config/env';
import {
  parseAndVerifyCommunityNftMetadata,
  serializeCommunityNftMetadataDeterministically,
} from '@/lib/ordinals/metadata';
import {
  extractOrdinalInscriptionEnvelope,
  isStandardP2PKHScript,
  parseOrdinalOutputScript,
} from '@/lib/ordinals/script-parser';

export interface OneSatMintingAdapterOptions {
  /** Authenticated BRC-100 WalletInterface (e.g., Yours Wallet window.CWI or HandCash BRC-100 bridge) */
  wallet?: WalletInterface;
  /** Explicit wallet provider route ('yours' uses @1sat/actions inscribe; 'handcash' uses wallet.createAction) */
  provider?: 'yours' | 'handcash';
  /** Authoritative BSV network (required in browser environments where server env vars are absent) */
  network?: 'main' | 'test';
  /** Explicit runtime mode for browser execution */
  appMode?: 'mock' | 'live';
  /** Test-only override allowing simulated BRC-100 substrates to execute live mint flow in offline unit tests */
  allowSimulatedLiveMint?: boolean;
  /** Explicit approval gate required before constructing/broadcasting mainnet mint transactions */
  allowMainnetMint?: boolean;
  /** Optional 1Sat Stack API base URL (defaults to ONESAT_API_BASE_URL) */
  apiBaseUrl?: string;
  /** Optional lookup provider for retrieving signed tx bytes when wallet returns txid without AtomicBEEF */
  lookupProvider?: MintTransactionLookupProvider;
  /** Optional override for `@1sat/actions` `inscribe.execute` in unit tests */
  customInscribeAction?: (
    ctx: OneSatContext,
    input: InscribeRequest
  ) => Promise<InscribeResponse>;
  /** Environment config override */
  envSource?: Record<string, string | undefined>;
}

/**
 * Live 1Sat Stack transaction lookup provider using `@1sat/client` (`OneSatServices`).
 * Retrieves raw transaction bytes via BeefClient / TxoClient to verify outputs and confirmations.
 */
export class OneSatTransactionLookupProvider implements MintTransactionLookupProvider {
  private readonly services: OneSatServices;
  private readonly configuredNetwork: 'main' | 'test';

  constructor(options?: { apiBaseUrl?: string; network?: 'main' | 'test' }) {
    const env = parseAppEnv();
    const network = options?.network ?? env.BSV_NETWORK;
    this.configuredNetwork = network;
    this.services = new OneSatServices(network, options?.apiBaseUrl ?? env.ONESAT_API_BASE_URL);
  }

  public async getTransaction(
    txid: string,
    expectedNetwork: 'main' | 'test'
  ): Promise<ObservedChainTransaction | null> {
    if (expectedNetwork !== this.configuredNetwork) {
      return null;
    }

    const normalizedTxid = txid.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedTxid)) {
      return null;
    }

    try {
      const rawBytes = await this.services.beef.getRawTx(normalizedTxid);
      const tx = Transaction.fromBinary(Array.from(rawBytes));
      const txOutputs = await this.services.txo.getByTxid(normalizedTxid, {
        block: true,
        sats: true,
      });

      const firstIndexed = txOutputs[0];
      const blockHeight =
        firstIndexed?.blockHeight && firstIndexed.blockHeight > 0
          ? firstIndexed.blockHeight
          : null;

      let confirmations = 0;
      if (blockHeight !== null) {
        try {
          const tipHeight = await this.services.getHeight();
          if (typeof tipHeight === 'number' && tipHeight >= blockHeight) {
            confirmations = tipHeight - blockHeight + 1;
          } else {
            confirmations = 1;
          }
        } catch {
          confirmations = 1;
        }
      }

      return {
        txid: normalizedTxid,
        network: this.configuredNetwork,
        outputs: tx.outputs.map((out, vout) => ({
          vout,
          satoshis: out.satoshis ?? 1,
          lockingScriptHex: out.lockingScript.toHex().toLowerCase(),
        })),
        blockHeight,
        confirmations,
        isMock: false,
      };
    } catch {
      return null;
    }
  }
}

/**
 * OneSatMintingAdapter
 *
 * Real 1Sat Ordinal minting adapter supporting both:
 * - Yours Wallet (`window.CWI`) via `@1sat/actions` `inscribe.execute`
 * - HandCash Desktop BRC Wallet via documented BRC-100 `wallet.createAction` (+ `signAction`)
 *
 * Security & SDK Constraints:
 * - Blocked when `APP_MODE="mock"` unless `allowSimulatedLiveMint` is enabled for unit tests.
 * - Refuses mainnet broadcasting unless explicitly permitted via `allowMainnetMint` / `ALLOW_MAINNET_MINT=true`.
 * - Requires an active BRC-100 `WalletInterface` (never falls back to mock minting or custodial server keys).
 * - Never hardcodes `vout = 0` or fabricates `rawOutputScriptHex`: inspects the actual signed
 *   transaction outputs (AtomicBEEF / BEEF / raw tx / lookup provider) to resolve the true `(vout, rawOutputScriptHex)`.
 */
export class OneSatMintingAdapter implements OrdinalMintingAdapter {
  public readonly mode = 'live' as const;
  private readonly options: OneSatMintingAdapterOptions;
  private readonly wallet: WalletInterface | undefined;
  private readonly apiBaseUrl: string | undefined;
  private readonly envSource: Record<string, string | undefined>;

  constructor(options: OneSatMintingAdapterOptions = {}) {
    this.options = options;
    this.wallet = options.wallet;
    this.apiBaseUrl = options.apiBaseUrl;
    this.envSource =
      options.envSource ??
      (typeof process !== 'undefined' && process.env ? process.env : {});
  }

  private resolveRuntimeSettings(requestNetwork: 'main' | 'test'): {
    appMode: 'mock' | 'live';
    bsvNetwork: 'main' | 'test';
    oneSatApiBaseUrl: string;
    allowMainnetMint: boolean;
  } {
    const isBrowserClient = typeof window !== 'undefined' && !this.options.envSource;
    if (isBrowserClient) {
      const appMode: 'mock' | 'live' =
        this.options.appMode ??
        (process.env.NEXT_PUBLIC_APP_MODE === 'live' ? 'live' : 'mock');
      return {
        appMode,
        bsvNetwork: this.options.network ?? requestNetwork,
        oneSatApiBaseUrl: this.apiBaseUrl ?? 'https://api.1sat.app',
        allowMainnetMint: this.options.allowMainnetMint === true,
      };
    }

    const config = parseAppEnv(this.envSource);
    return {
      appMode: this.options.appMode ?? config.APP_MODE,
      bsvNetwork: this.options.network ?? config.BSV_NETWORK,
      oneSatApiBaseUrl: this.apiBaseUrl ?? config.ONESAT_API_BASE_URL,
      allowMainnetMint:
        this.options.allowMainnetMint === true ||
        this.envSource.ALLOW_MAINNET_MINT === 'true',
    };
  }

  private parseTransactionFromBytes(
    txid: string,
    txBytes: number[]
  ): Transaction | null {
    try {
      const tx = Transaction.fromBEEF(txBytes);
      if (tx.id('hex').toLowerCase() === txid) {
        return tx;
      }
    } catch {
      // Fallback to multi-tx BEEF or raw transaction binary
    }

    try {
      const beef = Beef.fromBinary(txBytes);
      const found = beef.findTxid(txid);
      if (found?.tx) {
        return found.tx;
      }
    } catch {
      // Fallback to raw transaction binary
    }

    try {
      const rawTx = Transaction.fromBinary(txBytes);
      if (rawTx.id('hex').toLowerCase() === txid) {
        return rawTx;
      }
    } catch {
      // Unparseable bytes
    }

    return null;
  }

  private async extractVerifiedMintOutputFromTransaction(params: {
    txid: string;
    txBytes?: number[] | Uint8Array | undefined;
    network: 'main' | 'test';
    oneSatApiBaseUrl: string;
    communityId: string;
    expectedOwnerScript: string;
    expectedContentSha256Hex: string;
  }): Promise<{ vout: number; rawOutputScriptHex: string }> {
    let candidateOutputs: ObservedChainTransactionOutput[] | null = null;

    if (params.txBytes && params.txBytes.length > 0) {
      const parsedTx = this.parseTransactionFromBytes(
        params.txid,
        Array.from(params.txBytes)
      );
      if (parsedTx) {
        candidateOutputs = parsedTx.outputs.map((out, index) => ({
          vout: index,
          satoshis: out.satoshis ?? 0,
          lockingScriptHex: out.lockingScript.toHex().toLowerCase(),
        }));
      }
    }

    if (!candidateOutputs && this.options.lookupProvider) {
      const lookedUp = await this.options.lookupProvider.getTransaction(
        params.txid,
        params.network
      );
      if (lookedUp) {
        candidateOutputs = lookedUp.outputs;
      }
    }

    if (!candidateOutputs) {
      try {
        const services = new OneSatServices(params.network, params.oneSatApiBaseUrl);
        const rawBytes = await services.beef.getRawTx(params.txid);
        const parsedTx = Transaction.fromBinary(Array.from(rawBytes));
        candidateOutputs = parsedTx.outputs.map((out, index) => ({
          vout: index,
          satoshis: out.satoshis ?? 0,
          lockingScriptHex: out.lockingScript.toHex().toLowerCase(),
        }));
      } catch {
        candidateOutputs = null;
      }
    }

    if (!candidateOutputs || candidateOutputs.length === 0) {
      throw new MintingAdapterError(
        'MINT_TX_OUTPUT_UNVERIFIABLE',
        `Unable to inspect signed transaction "${params.txid}" outputs to verify the actual 1Sat Ordinal vout and locking script.`,
        502
      );
    }

    for (const out of candidateOutputs) {
      if (out.satoshis !== 1) {
        continue;
      }
      const scriptHex = out.lockingScriptHex.trim().toLowerCase();
      const envelope = extractOrdinalInscriptionEnvelope(scriptHex);
      if (
        !envelope.hasOrdEnvelope ||
        envelope.contentType !== 'application/json' ||
        !envelope.contentUtf8
      ) {
        continue;
      }

      const parsedScript = parseOrdinalOutputScript(scriptHex);
      if (
        parsedScript.scriptType !== 'P2PKH' ||
        parsedScript.spendingScriptHex !== params.expectedOwnerScript
      ) {
        continue;
      }

      try {
        const metadata = parseAndVerifyCommunityNftMetadata(
          envelope.contentUtf8,
          params.communityId
        );
        const reserialized = serializeCommunityNftMetadataDeterministically({
          communityId: metadata.communityId,
          name: metadata.name,
          description: metadata.description ?? '',
          artworkUrl: metadata.artworkUrl ?? null,
        });
        if (reserialized.contentSha256Hex === params.expectedContentSha256Hex) {
          return {
            vout: out.vout,
            rawOutputScriptHex: scriptHex,
          };
        }
      } catch {
        continue;
      }
    }

    throw new MintingAdapterError(
      'MINT_TX_OUTPUT_UNVERIFIABLE',
      `Signed transaction "${params.txid}" does not contain a verifiable 1-satoshi Community NFT inscription output matching community "${params.communityId}" and owner script "${params.expectedOwnerScript}".`,
      502
    );
  }

  public async mintCommunityOrdinal(
    request: MintCommunityOrdinalRequest
  ): Promise<MintCommunityOrdinalResult> {
    const runtime = this.resolveRuntimeSettings(request.network);

    if (!this.options.allowSimulatedLiveMint) {
      if (typeof window !== 'undefined' && !this.options.envSource) {
        if (runtime.appMode !== 'live') {
          throw new MintingAdapterError(
            'LIVE_MODE_REQUIRED',
            'Live blockchain broadcasting/minting/spending is disabled while APP_MODE is "mock".',
            403
          );
        }
      } else {
        const config = parseAppEnv(this.envSource);
        assertLiveModeAuthorized(config);
      }
    }

    if (request.network !== runtime.bsvNetwork) {
      throw new MintingAdapterError(
        'NETWORK_MISMATCH',
        `Mint request network "${request.network}" does not match configured BSV_NETWORK "${runtime.bsvNetwork}".`,
        400
      );
    }

    if (runtime.bsvNetwork === 'main' && !runtime.allowMainnetMint) {
      throw new MintingAdapterError(
        'MAINNET_MINT_FORBIDDEN',
        'Mainnet 1Sat Ordinal minting is blocked unless ALLOW_MAINNET_MINT=true is explicitly authorized. Use BSV_NETWORK=test for live wallet testing.',
        403
      );
    }

    const ownerScript = request.destinationP2PKHScript.trim().toLowerCase();
    if (!isStandardP2PKHScript(ownerScript)) {
      throw new MintingAdapterError(
        'INVALID_DESTINATION_SCRIPT',
        'destinationP2PKHScript must be a valid 25-byte standard P2PKH locking script.',
        400
      );
    }

    if (!this.wallet) {
      throw new MintingAdapterError(
        'WALLET_SUBSTRATE_REQUIRED',
        'Live 1Sat Ordinal minting requires an authenticated BRC-100 WalletInterface substrate (Yours Wallet window.CWI or HandCash BRC-100 Wallet). Server-side custodial minting is disabled because private keys are never stored on the server.',
        501
      );
    }

    const serialized = serializeCommunityNftMetadataDeterministically({
      communityId: request.communityId,
      name: request.name,
      description: request.description,
      artworkUrl: request.artworkUrl ?? null,
    });

    const provider = this.options.provider ?? 'yours';
    let txid: string | undefined;
    let txBytes: number[] | Uint8Array | undefined;

    if (provider === 'handcash') {
      const inscriptionScript = buildInscriptionScript(
        LockingScript.fromHex(ownerScript),
        serialized.contentBytes,
        serialized.contentType,
        serialized.mapAttributes
      );

      const createResult = await this.wallet.createAction({
        description: `Mint 1Sat Community NFT (${serialized.metadata.name.slice(0, 24)})`,
        outputs: [
          {
            lockingScript: inscriptionScript.toHex().toLowerCase(),
            satoshis: 1,
            outputDescription: 'Community 1Sat Ordinal NFT',
            basket: '1sat',
            tags: [
              'type:application/json',
              'origin',
              `sha256:${serialized.contentSha256Hex}`,
            ],
            customInstructions: JSON.stringify({
              protocolID: DESTINATION_BRC100_PROTOCOL_ID,
              keyID: DEFAULT_DESTINATION_KEY_ID,
              name: serialized.metadata.name,
            }),
          },
        ],
        options: {
          randomizeOutputs: false,
          acceptDelayedBroadcast: false,
        },
      });

      if (createResult.txid) {
        txid = createResult.txid;
        txBytes = createResult.tx;
      } else if (createResult.signableTransaction) {
        const signedResult = await this.wallet.signAction({
          reference: createResult.signableTransaction.reference,
          spends: {},
          options: {
            acceptDelayedBroadcast: false,
          },
        });
        txid = signedResult.txid;
        txBytes = signedResult.tx;
      }

      if (!txid) {
        throw new MintingAdapterError(
          'HANDCASH_MINT_FAILED',
          'HandCash BRC-100 createAction did not return a signed transaction ID (txid).',
          502
        );
      }
    } else {
      const services = new OneSatServices(
        runtime.bsvNetwork,
        runtime.oneSatApiBaseUrl
      );
      const ctx = createContext(this.wallet, {
        services,
        chain: runtime.bsvNetwork,
      });

      const inscribeInput: InscribeRequest = {
        base64Content: serialized.contentBase64,
        contentType: serialized.contentType,
        map: serialized.mapAttributes,
        destination: {
          lockingScript: ownerScript,
        },
      };

      const response = this.options.customInscribeAction
        ? await this.options.customInscribeAction(ctx, inscribeInput)
        : await inscribe.execute(ctx, inscribeInput);

      if (response.error || !response.txid) {
        throw new MintingAdapterError(
          'ONESAT_INSCRIBE_FAILED',
          `1Sat Ordinal inscribe action failed: ${response.error ?? 'no txid returned by wallet'}`,
          502
        );
      }

      txid = response.txid;
      txBytes = response.tx;
    }

    const normalizedTxid = txid.trim().toLowerCase();
    const verifiedOutput = await this.extractVerifiedMintOutputFromTransaction({
      txid: normalizedTxid,
      txBytes,
      network: runtime.bsvNetwork,
      oneSatApiBaseUrl: runtime.oneSatApiBaseUrl,
      communityId: request.communityId,
      expectedOwnerScript: ownerScript,
      expectedContentSha256Hex: serialized.contentSha256Hex,
    });

    const origin = `${normalizedTxid}_${verifiedOutput.vout}`;

    return {
      txid: normalizedTxid,
      vout: verifiedOutput.vout,
      origin,
      rawOutputScriptHex: verifiedOutput.rawOutputScriptHex,
      ownerP2PKHScriptHex: ownerScript,
      canonicalMetadataJson: serialized.canonicalJson,
      contentSha256Hex: serialized.contentSha256Hex,
      network: runtime.bsvNetwork,
      blockHeight: null,
      confirmations: 0,
      isMock: false,
    };
  }
}
