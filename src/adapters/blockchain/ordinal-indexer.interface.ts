import type { OrdinalOwnershipState } from '@/types/ordinal';

export interface VerifiedTransactionOutput {
  outputIndex: number;
  satoshis: number;
  lockingScriptHex: string;
}

export interface VerifiedTransactionRecord {
  txid: string;
  network: 'main' | 'test';
  outputs: VerifiedTransactionOutput[];
  blockHeight: number | null;
  confirmations: number;
  isRejectedOrDoubleSpend: boolean;
  isMock: boolean;
}

/**
 * Abstraction for blockchain indexing and transaction verification.
 * Phase 1 defines the contract; concrete adapters are implemented in Phase 4.
 */
export interface OrdinalIndexerInterface {
  resolveOrdinalOwnership(origin: string): Promise<OrdinalOwnershipState | null>;

  verifyTransaction(txid: string): Promise<VerifiedTransactionRecord | null>;

  getCurrentBlockHeight(): Promise<number>;
}
