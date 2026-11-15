import { Hash } from '@bsv/sdk';
import {
  MintingAdapterError,
  type MintCommunityOrdinalRequest,
  type MintCommunityOrdinalResult,
  type MintTransactionLookupProvider,
  type ObservedChainTransaction,
  type OrdinalMintingAdapter,
} from '@/adapters/ordinals/minting-adapter';
import { serializeCommunityNftMetadataDeterministically } from '@/lib/ordinals/metadata';
import {
  build1SatOrdinalLockingScript,
  isStandardP2PKHScript,
} from '@/lib/ordinals/script-parser';

/**
 * In-memory registry of mock-minted transactions used during `APP_MODE=mock` and
 * automated tests so `MintVerificationService` can independently query and inspect
 * raw transaction outputs without trusting client-submitted metadata or scripts.
 */
export class MockChainTransactionStore implements MintTransactionLookupProvider {
  private readonly transactions = new Map<string, ObservedChainTransaction>();

  public registerTransaction(tx: ObservedChainTransaction): void {
    this.transactions.set(tx.txid.trim().toLowerCase(), {
      ...tx,
      txid: tx.txid.trim().toLowerCase(),
      outputs: tx.outputs.map((o) => ({
        ...o,
        lockingScriptHex: o.lockingScriptHex.trim().toLowerCase(),
      })),
    });
  }

  public async getTransaction(
    txid: string,
    _expectedNetwork: 'main' | 'test'
  ): Promise<ObservedChainTransaction | null> {
    const normalized = txid.trim().toLowerCase();
    const found = this.transactions.get(normalized);
    return found ? { ...found, outputs: [...found.outputs] } : null;
  }

  public clear(): void {
    this.transactions.clear();
  }
}

let sharedMockChainStore: MockChainTransactionStore | null = null;

export function getSharedMockChainTransactionStore(): MockChainTransactionStore {
  if (!sharedMockChainStore) {
    sharedMockChainStore = new MockChainTransactionStore();
  }
  return sharedMockChainStore;
}

export interface MockMintingAdapterOptions {
  chainStore?: MockChainTransactionStore;
  defaultConfirmations?: number;
  defaultBlockHeight?: number;
}

/**
 * MockMintingAdapter
 *
 * Clearly labeled simulated 1Sat Ordinal minting adapter for `APP_MODE=mock` and automated tests.
 * Constructs a genuine 1Sat Ordinal inscription script (`OP_FALSE OP_IF "ord" ... OP_ENDIF` + P2PKH)
 * with deterministic canonical JSON metadata and registers the simulated transaction in
 * `MockChainTransactionStore` for independent backend verification.
 * Never broadcasts to the live BSV network.
 */
export class MockMintingAdapter implements OrdinalMintingAdapter {
  public readonly mode = 'mock' as const;
  private readonly chainStore: MockChainTransactionStore;
  private readonly defaultConfirmations: number;
  private readonly defaultBlockHeight: number;

  constructor(options?: MockMintingAdapterOptions) {
    this.chainStore = options?.chainStore ?? getSharedMockChainTransactionStore();
    this.defaultConfirmations = options?.defaultConfirmations ?? 1;
    this.defaultBlockHeight = options?.defaultBlockHeight ?? 880_000;
  }

  public async mintCommunityOrdinal(
    request: MintCommunityOrdinalRequest
  ): Promise<MintCommunityOrdinalResult> {
    const ownerScript = request.destinationP2PKHScript.trim().toLowerCase();
    if (!isStandardP2PKHScript(ownerScript)) {
      throw new MintingAdapterError(
        'INVALID_DESTINATION_SCRIPT',
        'destinationP2PKHScript must be a valid 25-byte standard P2PKH locking script.'
      );
    }

    const serialized = serializeCommunityNftMetadataDeterministically({
      communityId: request.communityId,
      name: request.name,
      description: request.description,
      artworkUrl: request.artworkUrl ?? null,
    });

    const rawOutputScriptHex = build1SatOrdinalLockingScript({
      ownerP2PKHScriptHex: ownerScript,
      contentBytes: serialized.contentBytes,
      contentType: serialized.contentType,
    });

    const preimageBytes = Array.from(
      Buffer.from(
        `mock-1sat-ordinal-mint:v1:${request.network}:${serialized.metadata.communityId}:${ownerScript}:${serialized.contentSha256Hex}`,
        'utf8'
      )
    );
    const txid = Buffer.from(Hash.sha256(preimageBytes))
      .toString('hex')
      .toLowerCase();

    const vout = 0;
    const origin = `${txid}_${vout}`;
    const confirmations =
      request.simulatedConfirmations ?? this.defaultConfirmations;
    const blockHeight =
      request.simulatedBlockHeight !== undefined
        ? request.simulatedBlockHeight
        : confirmations > 0
          ? this.defaultBlockHeight
          : null;

    this.chainStore.registerTransaction({
      txid,
      network: request.network,
      outputs: [
        {
          vout,
          satoshis: 1,
          lockingScriptHex: rawOutputScriptHex,
        },
      ],
      blockHeight,
      confirmations,
      isMock: true,
    });

    return {
      txid,
      vout,
      origin,
      rawOutputScriptHex,
      ownerP2PKHScriptHex: ownerScript,
      canonicalMetadataJson: serialized.canonicalJson,
      contentSha256Hex: serialized.contentSha256Hex,
      network: request.network,
      blockHeight,
      confirmations,
      isMock: true,
    };
  }
}
