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

  const [yoursAvailable, handcashDiscovery, mockAvailable] = await Promise.all([
    yoursAdapter.isAvailable(),
    handcashAdapter.discoverBridge(),
    mockAdapter.isAvailable(),
  ]);

  const yoursCapabilities = yoursAdapter.getCapabilities();
  const mockCapabilities = mockAdapter.getCapabilities();

  const results: WalletProviderDiscovery[] = [
    {
      provider: 'yours',
      displayName: 'Yours Wallet',
      available: yoursAvailable,
      transport: yoursCapabilities.connectionTransport === 'legacy-yours'
        ? 'yours-extension'
        : yoursCapabilities.connectionTransport === 'brc100-cwi'
          ? 'brc100-cwi'
          : 'none',
      capabilities: yoursCapabilities,
      details: yoursAvailable
        ? `Yours Wallet detected (${yoursCapabilities.connectionTransport}) and ready for explicit connection.`
        : 'Yours Wallet extension / BRC-100 window.CWI not detected.',
    },
    {
      provider: 'handcash',
      displayName: 'HandCash BRC-100 Wallet',
      available: handcashDiscovery.available,
      transport: handcashDiscovery.transport,
      ...(handcashDiscovery.version ? { version: handcashDiscovery.version } : {}),
      capabilities: handcashDiscovery.capabilities ?? handcashAdapter.getCapabilities(),
      details: handcashDiscovery.details,
    },
  ];

  if ((env.appMode ?? 'mock') === 'mock') {
    results.push({
      provider: 'mock',
      displayName: 'Mock Test Wallet (Safe Local Mode)',
      available: mockAvailable,
      transport: 'mock',
      capabilities: mockCapabilities,
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
