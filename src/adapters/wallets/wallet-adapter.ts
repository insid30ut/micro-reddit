import type { WalletInterface } from '@bsv/sdk';
import type {
  MintOrdinalInput,
  MintResult,
  PaymentOutput,
  SignatureResult,
  TransactionResult,
  VerifiedWalletDestination,
  WalletCapabilities,
  WalletConnectionResult,
  WalletErrorCode,
  WalletIdentity,
  WalletProviderType,
} from '@/types/wallet';

/**
 * Normalized WalletAdapter interface required by POC_BLUEPRINT.md Section 5.3
 * and the shared BRC-100 wallet completion specification.
 */
export interface WalletAdapter {
  readonly provider: WalletProviderType;

  isAvailable(): Promise<boolean>;

  connect(): Promise<WalletConnectionResult>;

  disconnect(): Promise<void>;

  getIdentity(): Promise<WalletIdentity>;

  getCapabilities(): WalletCapabilities;

  getWalletInterface(): WalletInterface | null;

  deriveDestination(options?: { keyID?: string }): Promise<VerifiedWalletDestination>;

  signChallenge(challenge: string): Promise<SignatureResult>;

  sendOutputs(outputs: PaymentOutput[]): Promise<TransactionResult>;

  mintOrdinal(input: MintOrdinalInput): Promise<MintResult>;

  getNetwork(): Promise<'main' | 'test'>;
}

export class WalletConnectionError extends Error {
  public readonly provider: WalletProviderType;
  public readonly code: WalletErrorCode;

  constructor(
    provider: WalletProviderType,
    code: WalletErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WalletConnectionError';
    this.provider = provider;
    this.code = code;
  }
}

export class UnsupportedWalletOperationError extends WalletConnectionError {
  public readonly operation: string;

  constructor(
    provider: WalletProviderType,
    operation: string,
    message?: string
  ) {
    super(
      provider,
      'UNSUPPORTED_OPERATION',
      message ??
        `Operation "${operation}" is not supported by wallet provider "${provider}".`
    );
    this.name = 'UnsupportedWalletOperationError';
    this.operation = operation;
  }
}
