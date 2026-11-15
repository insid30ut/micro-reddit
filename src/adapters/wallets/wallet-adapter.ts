import type {
  MintOrdinalInput,
  MintResult,
  PaymentOutput,
  SignatureResult,
  TransactionResult,
  WalletConnectionResult,
  WalletIdentity,
  WalletProviderType,
} from '@/types/wallet';

/**
 * Normalized WalletAdapter interface required by POC_BLUEPRINT.md Section 5.3.
 * Phase 1 defines the contract only; provider implementations are added in Phase 2.
 */
export interface WalletAdapter {
  readonly provider: WalletProviderType;

  connect(): Promise<WalletConnectionResult>;

  disconnect(): Promise<void>;

  getIdentity(): Promise<WalletIdentity>;

  signChallenge(challenge: string): Promise<SignatureResult>;

  sendOutputs(outputs: PaymentOutput[]): Promise<TransactionResult>;

  mintOrdinal(input: MintOrdinalInput): Promise<MintResult>;

  getNetwork(): Promise<'main' | 'test'>;
}

export class UnsupportedWalletOperationError extends Error {
  public readonly provider: WalletProviderType;
  public readonly operation: string;

  constructor(provider: WalletProviderType, operation: string, message?: string) {
    super(
      message ??
        `Operation "${operation}" is not supported by wallet provider "${provider}".`
    );
    this.name = 'UnsupportedWalletOperationError';
    this.provider = provider;
    this.operation = operation;
  }
}
