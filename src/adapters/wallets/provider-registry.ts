import {
  HandCashWalletAdapter,
  type HandCashWalletAdapterOptions,
} from '@/adapters/wallets/handcash.adapter';
import {
  MockWalletAdapter,
  type MockWalletAdapterOptions,
} from '@/adapters/wallets/mock.adapter';
import {
  type WalletAdapter,
  WalletConnectionError,
} from '@/adapters/wallets/wallet-adapter';
import {
  YoursWalletAdapter,
  type YoursWalletAdapterOptions,
} from '@/adapters/wallets/yours.adapter';
import type {
  WalletProviderDiscovery,
  WalletProviderType,
} from '@/types/wallet';

export interface WalletRegistryEnvironment {
  appMode?: 'mock' | 'live';
  yoursOptions?: YoursWalletAdapterOptions;
  handcashOptions?: HandCashWalletAdapterOptions;
  mockOptions?: MockWalletAdapterOptions;
}

/**
 * Discovers which wallet providers are available in the current environment
 * without automatically connecting to any of them.
 *
 * When multiple wallets (e.g., both Yours and HandCash) are installed,
 * both are reported as available and the user MUST explicitly select one.
 */
export async function discoverAvailableWallets(
  env: WalletRegistryEnvironment = {}
): Promise<WalletProviderDiscovery[]> {
  const yoursAdapter = new YoursWalletAdapter(env.yoursOptions);
  const handcashAdapter = new HandCashWalletAdapter(env.handcashOptions);
  const mockAdapter = new MockWalletAdapter(env.mockOptions);

  const [yoursAvailable, handcashAvailable, mockAvailable] = await Promise.all([
    yoursAdapter.isAvailable(),
    handcashAdapter.isAvailable(),
    mockAdapter.isAvailable(),
  ]);

  const results: WalletProviderDiscovery[] = [
    {
      provider: 'yours',
      displayName: 'Yours Wallet',
      available: yoursAvailable,
      transport: env.yoursOptions?.injectedExtension
        ? 'yours-extension'
        : 'brc100-cwi',
      details: yoursAvailable
        ? 'Yours Wallet detected and ready for explicit connection.'
        : 'Yours Wallet extension / BRC-100 CWI not detected.',
    },
    {
      provider: 'handcash',
      displayName: 'HandCash BRC-100 Wallet',
      available: handcashAvailable,
      transport: 'brc100-json-api',
      details: handcashAvailable
        ? 'HandCash BRC-100 local bridge detected and ready for explicit connection.'
        : 'HandCash BRC-100 local bridge not detected.',
    },
  ];

  if ((env.appMode ?? 'mock') === 'mock') {
    results.push({
      provider: 'mock',
      displayName: 'Mock Test Wallet (Safe Local Mode)',
      available: mockAvailable,
      transport: 'mock',
      details: 'Deterministic @bsv/sdk ProtoWallet for local mock testing.',
    });
  }

  return results;
}

/**
 * Creates a WalletAdapter for the explicitly requested provider.
 *
 * Never performs automatic provider selection (`auto` is forbidden).
 * If `provider` is omitted or invalid, throws a `WalletConnectionError`.
 */
export function createExplicitWalletAdapter(
  provider: WalletProviderType | undefined | null,
  env: WalletRegistryEnvironment = {}
): WalletAdapter {
  if (!provider) {
    throw new WalletConnectionError(
      'mock',
      'PROVIDER_MISMATCH',
      'Explicit wallet provider selection is required ("yours", "handcash", or "mock"). Automatic provider selection is disabled.'
    );
  }

  switch (provider) {
    case 'yours':
      return new YoursWalletAdapter(env.yoursOptions);
    case 'handcash':
      return new HandCashWalletAdapter(env.handcashOptions);
    case 'mock': {
      if (env.appMode === 'live') {
        throw new WalletConnectionError(
          'mock',
          'PROVIDER_MISMATCH',
          'Mock wallet provider cannot be selected when APP_MODE is "live".'
        );
      }
      return new MockWalletAdapter(env.mockOptions);
    }
    default:
      throw new WalletConnectionError(
        'mock',
        'PROVIDER_MISMATCH',
        `Unsupported wallet provider "${String(provider)}".`
      );
  }
}
