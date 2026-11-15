import type {
  WalletConnectionState,
  WalletIdentity,
  WalletProviderType,
} from '@/types/wallet';
import type { WalletAdapter } from '@/adapters/wallets/wallet-adapter';
import {
  createExplicitWalletAdapter,
  type WalletRegistryEnvironment,
} from '@/adapters/wallets/provider-registry';

export interface WalletStateSnapshot {
  state: WalletConnectionState;
  selectedProvider: WalletProviderType | null;
  identity: WalletIdentity | null;
  errorMessage: string | null;
}

export type WalletStateListener = (snapshot: WalletStateSnapshot) => void;

/**
 * Manages explicit wallet provider selection and connection state transitions.
 * Never auto-connects or races multiple wallets — requires an explicit provider argument.
 */
export class WalletConnectionStateManager {
  private state: WalletConnectionState = 'disconnected';
  private selectedProvider: WalletProviderType | null = null;
  private activeAdapter: WalletAdapter | null = null;
  private identity: WalletIdentity | null = null;
  private errorMessage: string | null = null;
  private readonly listeners = new Set<WalletStateListener>();

  public getSnapshot(): WalletStateSnapshot {
    return {
      state: this.state,
      selectedProvider: this.selectedProvider,
      identity: this.identity ? { ...this.identity } : null,
      errorMessage: this.errorMessage,
    };
  }

  public getActiveAdapter(): WalletAdapter | null {
    return this.activeAdapter;
  }

  public subscribe(listener: WalletStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }

  /**
   * Explicitly selects and connects to the user-chosen wallet provider.
   */
  public async connectProvider(
    provider: WalletProviderType,
    options?: WalletRegistryEnvironment,
    customAdapter?: WalletAdapter
  ): Promise<WalletIdentity> {
    if (this.activeAdapter) {
      await this.activeAdapter.disconnect();
    }

    this.selectedProvider = provider;
    this.state = 'connecting';
    this.errorMessage = null;
    this.emit();

    try {
      const adapter = customAdapter ?? createExplicitWalletAdapter(provider, options);
      const connectionResult = await adapter.connect();
      const walletIdentity = await adapter.getIdentity();

      this.activeAdapter = adapter;
      this.identity = {
        ...walletIdentity,
        ...(connectionResult.payoutScript ? { payoutScript: connectionResult.payoutScript } : {}),
      };
      this.state = 'connected';
      this.emit();
      return { ...this.identity };
    } catch (error) {
      this.activeAdapter = null;
      this.identity = null;
      this.state = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    }
  }

  /**
   * Transitions through 'authenticating' -> 'authenticated' while signing a challenge
   * with the connected wallet adapter and verifying it.
   */
  public async authenticateWithChallenge<TResult>(
    challengeText: string,
    verifyFn: (params: {
      provider: WalletProviderType;
      identity: WalletIdentity;
      signature: string;
      publicKey: string;
      keyID?: string;
      signatureScheme?: 'brc100' | 'ecdsa-sha256' | 'bsm';
    }) => Promise<TResult>
  ): Promise<TResult> {
    if (!this.activeAdapter || !this.identity || !this.selectedProvider) {
      this.state = 'error';
      this.errorMessage = 'Cannot authenticate before connecting a wallet.';
      this.emit();
      throw new Error('Cannot authenticate before connecting a wallet.');
    }

    this.state = 'authenticating';
    this.errorMessage = null;
    this.emit();

    try {
      const sigResult = await this.activeAdapter.signChallenge(challengeText);
      const verified = await verifyFn({
        provider: this.selectedProvider,
        identity: this.identity,
        signature: sigResult.signature,
        publicKey: sigResult.publicKey,
        ...(sigResult.keyID ? { keyID: sigResult.keyID } : {}),
        ...(sigResult.signatureScheme ? { signatureScheme: sigResult.signatureScheme } : {}),
      });

      this.state = 'authenticated';
      this.emit();
      return verified;
    } catch (error) {
      this.state = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    }
  }

  /**
   * Disconnects the active wallet adapter and resets state to 'disconnected'.
   */
  public async disconnect(): Promise<void> {
    if (this.activeAdapter) {
      await this.activeAdapter.disconnect();
    }
    this.activeAdapter = null;
    this.selectedProvider = null;
    this.identity = null;
    this.errorMessage = null;
    this.state = 'disconnected';
    this.emit();
  }
}
