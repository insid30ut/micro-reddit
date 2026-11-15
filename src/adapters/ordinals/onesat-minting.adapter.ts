import { createContext, inscribe } from '@1sat/actions';
import { OneSatServices } from '@1sat/client';
import { Transaction, type WalletInterface } from '@bsv/sdk';
import {
  MintingAdapterError,
  type MintCommunityOrdinalRequest,
  type MintCommunityOrdinalResult,
  type MintTransactionLookupProvider,
  type ObservedChainTransaction,
  type OrdinalMintingAdapter,
} from '@/adapters/ordinals/minting-adapter';
import { assertLiveModeAuthorized, parseAppEnv } from '@/lib/config/env';
import { serializeCommunityNftMetadataDeterministically } from '@/lib/ordinals/metadata';
import {
  build1SatOrdinalLockingScript,
  isStandardP2PKHScript,
} from '@/lib/ordinals/script-parser';

export interface OneSatMintingAdapterOptions {
  /** Authenticated BRC-100 WalletInterface (e.g., Yours Wallet CWI substrate) */
  wallet?: WalletInterface;
  /** Optional 1Sat Stack API base URL (defaults to ONESAT_API_BASE_URL) */
  apiBaseUrl?: string;
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
 * Real 1Sat Ordinal minting adapter backed by `@1sat/actions` (`inscribe`) and `@1sat/client`.
 *
 * Security & SDK Constraints:
 * - Strictly blocked when `APP_MODE="mock"` via `assertLiveModeAuthorized()`.
 * - Requires an active BRC-100 `WalletInterface` (such as Yours Wallet's BRC-100 CWI substrate)
 *   to fund and sign the inscription transaction client-side.
 * - Never fabricates transactions or falls back to mock minting when a live wallet is absent.
 */
export class OneSatMintingAdapter implements OrdinalMintingAdapter {
  public readonly mode = 'live' as const;
  private readonly wallet: WalletInterface | undefined;
  private readonly apiBaseUrl: string | undefined;
  private readonly envSource: Record<string, string | undefined>;

  constructor(options?: OneSatMintingAdapterOptions) {
    this.wallet = options?.wallet;
    this.apiBaseUrl = options?.apiBaseUrl;
    this.envSource = options?.envSource ?? process.env;
  }

  public async mintCommunityOrdinal(
    request: MintCommunityOrdinalRequest
  ): Promise<MintCommunityOrdinalResult> {
    const config = parseAppEnv(this.envSource);
    assertLiveModeAuthorized(config);

    if (request.network !== config.BSV_NETWORK) {
      throw new MintingAdapterError(
        'NETWORK_MISMATCH',
        `Mint request network "${request.network}" does not match server BSV_NETWORK "${config.BSV_NETWORK}".`,
        400
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
        'Live 1Sat Ordinal minting requires an authenticated BRC-100 WalletInterface substrate (e.g., Yours Wallet in browser). Server-side custodial minting is disabled because private keys are never stored on the server.',
        501
      );
    }

    const serialized = serializeCommunityNftMetadataDeterministically({
      communityId: request.communityId,
      name: request.name,
      description: request.description,
      artworkUrl: request.artworkUrl ?? null,
    });

    const services = new OneSatServices(
      config.BSV_NETWORK,
      this.apiBaseUrl ?? config.ONESAT_API_BASE_URL
    );
    const ctx = createContext(this.wallet, {
      services,
      chain: config.BSV_NETWORK,
    });

    const response = await inscribe.execute(ctx, {
      base64Content: serialized.contentBase64,
      contentType: serialized.contentType,
      map: serialized.mapAttributes,
      destination: {
        lockingScript: ownerScript,
      },
    });

    if (response.error || !response.txid) {
      throw new MintingAdapterError(
        'ONESAT_INSCRIBE_FAILED',
        `1Sat Ordinal inscribe action failed: ${response.error ?? 'no txid returned by wallet'}`,
        502
      );
    }

    const txid = response.txid.trim().toLowerCase();
    const vout = 0;
    const origin = `${txid}_${vout}`;
    const rawOutputScriptHex = build1SatOrdinalLockingScript({
      ownerP2PKHScriptHex: ownerScript,
      contentBytes: serialized.contentBytes,
      contentType: serialized.contentType,
    });

    return {
      txid,
      vout,
      origin,
      rawOutputScriptHex,
      ownerP2PKHScriptHex: ownerScript,
      canonicalMetadataJson: serialized.canonicalJson,
      contentSha256Hex: serialized.contentSha256Hex,
      network: config.BSV_NETWORK,
      blockHeight: null,
      confirmations: 0,
      isMock: false,
    };
  }
}
