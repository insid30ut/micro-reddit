import { describe, expect, it } from 'vitest';
import {
  assertLiveModeAuthorized,
  DEV_DEFAULT_SESSION_SECRET,
  parseAppEnv,
  resolveValidatedSessionSecret,
} from '@/lib/config/env';

describe('Environment Configuration & Mock Mode Safeguards', () => {
  it('defaults APP_MODE and NEXT_PUBLIC_APP_MODE to "mock"', () => {
    const config = parseAppEnv({});
    expect(config.APP_MODE).toBe('mock');
    expect(config.NEXT_PUBLIC_APP_MODE).toBe('mock');
    expect(config.OWNER_SHARE_BPS).toBe(7000);
    expect(config.PLATFORM_SHARE_BPS).toBe(3000);
    expect(config.OWNERSHIP_CONFIRMATIONS_REQUIRED).toBeGreaterThanOrEqual(1);
    expect(config.PAYMENT_CONFIRMATIONS_REQUIRED).toBeGreaterThanOrEqual(1);
    expect(config.SESSION_SECRET).toBe(DEV_DEFAULT_SESSION_SECRET);
  });

  it('blocks live blockchain operations when APP_MODE is "mock"', () => {
    const mockConfig = parseAppEnv({ APP_MODE: 'mock', NEXT_PUBLIC_APP_MODE: 'mock' });
    expect(() => assertLiveModeAuthorized(mockConfig)).toThrow(
      /disabled while APP_MODE is "mock"/i
    );
  });

  it('rejects 0 confirmations for ownership or payment thresholds', () => {
    expect(() =>
      parseAppEnv({ OWNERSHIP_CONFIRMATIONS_REQUIRED: '0' })
    ).toThrow(/at least 1/i);
    expect(() =>
      parseAppEnv({ PAYMENT_CONFIRMATIONS_REQUIRED: '0' })
    ).toThrow(/at least 1/i);
  });

  it('rejects invalid PLATFORM_PAYOUT_SCRIPT or mismatched basis points', () => {
    expect(() =>
      parseAppEnv({ PLATFORM_PAYOUT_SCRIPT: 'deadbeef' })
    ).toThrow(/standard P2PKH/i);

    expect(() =>
      parseAppEnv({ OWNER_SHARE_BPS: '6000', PLATFORM_SHARE_BPS: '3000' })
    ).toThrow(/must equal 10000/i);
  });

  it('rejects missing, weak, or placeholder SESSION_SECRET in production or live mode', () => {
    // Missing SESSION_SECRET in NODE_ENV=production
    expect(() =>
      parseAppEnv({ NODE_ENV: 'production' })
    ).toThrow(/SESSION_SECRET is required/i);

    // Missing SESSION_SECRET in APP_MODE=live
    expect(() =>
      parseAppEnv({ APP_MODE: 'live', NEXT_PUBLIC_APP_MODE: 'live' })
    ).toThrow(/SESSION_SECRET is required/i);

    // Development placeholder secret rejected in NODE_ENV=production
    expect(() =>
      parseAppEnv({
        NODE_ENV: 'production',
        SESSION_SECRET: DEV_DEFAULT_SESSION_SECRET,
      })
    ).toThrow(/placeholder/i);

    // Weak secret (< 32 chars) rejected in any environment
    expect(() =>
      parseAppEnv({ SESSION_SECRET: 'too-short-secret' })
    ).toThrow(/at least 32 characters/i);

    expect(() =>
      resolveValidatedSessionSecret(undefined, { NODE_ENV: 'production' })
    ).toThrow(/SESSION_SECRET must be explicitly configured/i);

    expect(() =>
      resolveValidatedSessionSecret(
        'dev-mock-mode-session-secret-minimum-32-characters-long',
        { NODE_ENV: 'production' }
      )
    ).toThrow(/placeholder/i);

    // Valid strong production secret succeeds
    const prodConfig = parseAppEnv({
      NODE_ENV: 'production',
      APP_MODE: 'live',
      NEXT_PUBLIC_APP_MODE: 'live',
      SESSION_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
    });
    expect(prodConfig.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
  });
});
