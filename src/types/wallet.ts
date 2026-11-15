export type WalletProviderType = 'yours' | 'handcash' | 'mock';

export interface WalletIdentity {
  provider: WalletProviderType;
  identityKey: string;
  publicKey: string;
  /** Standard 25-byte P2PKH locking script in hex if known/derivable */
  payoutScript?: string;
  network: 'main' | 'test';
}

export interface WalletConnectionResult {
  provider: WalletProviderType;
  identityKey: string;
  publicKey: string;
  payoutScript?: string;
  network: 'main' | 'test';
}

export interface SignatureResult {
  signature: string;
  publicKey: string;
  challenge: string;
}

export interface PaymentOutput {
  /** Destination locking script in lowercase hex (e.g., 25-byte P2PKH script) */
  lockingScript: string;
  /** Exact integer amount in satoshis */
  satoshis: number;
  /** Human-readable output description for BRC-100 createAction */
  description: string;
}

export interface TransactionResult {
  txid: string;
  rawTxHex?: string;
  isMock: boolean;
}

export interface OrdinalMetadata {
  app: 'community-platform';
  type: 'ord';
  name: string;
  communityId: string;
  schemaVersion: 1;
  platform: 'community-platform';
}

export interface MintOrdinalInput {
  contentBase64: string;
  contentType: string;
  metadata: OrdinalMetadata;
  destinationScript?: string;
}

export interface MintResult {
  txid: string;
  vout: number;
  origin: string;
  lockingScript: string;
  isMock: boolean;
}
