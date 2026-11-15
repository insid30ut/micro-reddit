export type WalletProviderType = 'yours' | 'handcash' | 'mock';

export type SignatureScheme = 'brc100' | 'ecdsa-sha256' | 'bsm';

export type WalletConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'authenticating'
  | 'authenticated'
  | 'error';

export type WalletErrorCode =
  | 'WALLET_NOT_FOUND'
  | 'USER_REJECTED'
  | 'WALLET_LOCKED'
  | 'PROVIDER_MISMATCH'
  | 'NETWORK_ERROR'
  | 'UNSUPPORTED_OPERATION'
  | 'AUTHENTICATION_FAILED';

export interface WalletIdentity {
  provider: WalletProviderType;
  /** Compressed 33-byte secp256k1 identity public key in lowercase hex (66 chars) */
  identityKey: string;
  /** Compressed 33-byte secp256k1 public key in lowercase hex (66 chars) */
  publicKey: string;
  /** Standard 25-byte P2PKH locking script in lowercase hex (76a914<20-byte-pkh>88ac) */
  payoutScript?: string;
  network: 'main' | 'test';
  /** Optional human-readable handle or label if exposed by the wallet */
  displayName?: string;
  /** Underlying wallet version string (e.g., "yours-2.1.0", "handcash-1.0.0", "mock-1.0.0") */
  version?: string;
}

export interface WalletConnectionResult {
  provider: WalletProviderType;
  identityKey: string;
  publicKey: string;
  payoutScript?: string;
  network: 'main' | 'test';
  displayName?: string;
  version?: string;
}

export interface SignatureResult {
  /** Hex-encoded DER signature (brc100 / ecdsa-sha256) or base64 signature (bsm) */
  signature: string;
  /** Compressed 33-byte secp256k1 public key in hex (66 chars) */
  publicKey: string;
  /** Exact challenge message signed by the wallet */
  challenge: string;
  /** BRC-100 keyID used during signing (defaults to extracted nonce or "auth-challenge") */
  keyID?: string;
  /** Cryptographic signature scheme used by the wallet provider */
  signatureScheme?: SignatureScheme;
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

export interface WalletProviderDiscovery {
  provider: WalletProviderType;
  displayName: string;
  available: boolean;
  transport: 'brc100-cwi' | 'yours-extension' | 'brc100-json-api' | 'mock';
  details: string;
}
