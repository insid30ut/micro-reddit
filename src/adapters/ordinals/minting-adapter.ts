export interface MintCommunityOrdinalRequest {
  communityId: string;
  name: string;
  description: string;
  artworkUrl?: string | null;
  /** Standard 25-byte P2PKH locking script (hex) that will own the minted 1Sat Ordinal */
  destinationP2PKHScript: string;
  /** Server-enforced BSV network ('main' | 'test') */
  network: 'main' | 'test';
  /** Optional simulated confirmation count (used only by MockMintingAdapter in tests) */
  simulatedConfirmations?: number;
  /** Optional simulated block height (used only by MockMintingAdapter in tests) */
  simulatedBlockHeight?: number | null;
}

export interface MintCommunityOrdinalResult {
  txid: string;
  vout: number;
  /** Canonical permanent genesis identifier: "<txid>_<vout>" */
  origin: string;
  /** Full output locking script hex including 1Sat "ord" envelope + P2PKH spending condition */
  rawOutputScriptHex: string;
  /** Extracted 25-byte P2PKH locking script hex of the initial owner */
  ownerP2PKHScriptHex: string;
  /** Deterministic canonical JSON string inscribed in the ordinal envelope */
  canonicalMetadataJson: string;
  /** SHA-256 hex digest of the canonical metadata bytes */
  contentSha256Hex: string;
  network: 'main' | 'test';
  blockHeight: number | null;
  confirmations: number;
  isMock: boolean;
}

export interface ObservedChainTransactionOutput {
  vout: number;
  satoshis: number;
  lockingScriptHex: string;
}

export interface ObservedChainTransaction {
  txid: string;
  network: 'main' | 'test';
  outputs: ObservedChainTransactionOutput[];
  blockHeight: number | null;
  confirmations: number;
  isMock: boolean;
}

/**
 * Provider interface used by MintVerificationService to independently look up
 * a transaction and its outputs from the chain/indexer rather than trusting client payloads.
 */
export interface MintTransactionLookupProvider {
  getTransaction(
    txid: string,
    expectedNetwork: 'main' | 'test'
  ): Promise<ObservedChainTransaction | null>;
}

/**
 * Modular Ordinal Minting Adapter interface.
 */
export interface OrdinalMintingAdapter {
  readonly mode: 'mock' | 'live';
  mintCommunityOrdinal(
    request: MintCommunityOrdinalRequest
  ): Promise<MintCommunityOrdinalResult>;
}

export class MintingAdapterError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'MintingAdapterError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
