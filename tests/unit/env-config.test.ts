import { describe, expect, it } from 'vitest';
import { assertLiveModeAuthorized, parseAppEnv } from '@/lib/config/env';

describe('Environment Configuration & Mock Mode Safeguards', () => {
  it('defaults APP_MODE and NEXT_PUBLIC_APP_MODE to "mock"', () => {
    const config = parseAppEnv({});
    expect(config.APP_MODE).toBe('mock');
    expect(config.NEXT_PUBLIC_APP_MODE).toBe('mock');
    expect(config.OWNER_SHARE_BPS).toBe(7000);
    expect(config.PLATFORM_SHARE_BPS).toBe(3000);
    expect(config.OWNERSHIP_CONFIRMATIONS_REQUIRED).toBeGreaterThanOrEqual(1);
    expect(config.PAYMENT_CONFIRMATIONS_REQUIRED).toBeGreaterThanOrEqual(1);
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
});
