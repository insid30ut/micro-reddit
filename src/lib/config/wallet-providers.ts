import type { WalletProviderType } from '@/types/wallet';

/**
 * Real (non-mock) wallet providers that are currently switched on.
 *
 * HandCash is intentionally disabled. The existing HandCashWalletAdapter targets a
 * local HandCash Desktop BRC-100 bridge (127.0.0.1:2121 / :3321) whose existence we
 * could not confirm from any HandCash documentation, and the HandCash Connect cloud
 * SDK cannot sign challenges, prove derived payment destinations, or mint 1Sat
 * Ordinals to a user-controlled script. See docs/WALLET_INTEGRATION.md.
 *
 * The adapter code is kept so HandCash can be re-enabled by adding it here once a
 * supported integration path exists.
 */
export const ENABLED_REAL_WALLET_PROVIDERS: readonly WalletProviderType[] = [
  'yours',
] as const;

/**
 * Whether a provider may be offered and authenticated. The mock provider is governed
 * separately by APP_MODE (allowed only in mock mode).
 */
export function isWalletProviderEnabled(provider: WalletProviderType): boolean {
  return provider === 'mock' || ENABLED_REAL_WALLET_PROVIDERS.includes(provider);
}
