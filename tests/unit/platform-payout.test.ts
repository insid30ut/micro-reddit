import { describe, expect, it } from 'vitest';
import { OneSatMintingAdapter } from '@/adapters/ordinals/onesat-minting.adapter';
import {
  assertBroadcastAuthorized,
  canBroadcastTransaction,
  parseAppEnv,
} from '@/lib/config/env';
import {
  deriveVerifiedMainnetPayoutScript,
  mainnetAddressFromPayoutScript,
} from '@/lib/config/payout-address';
import { buildPaymentIntentSnapshot } from '@/lib/payments/revenue-calculator';

const PAYOUT_ADDRESS = '1Chi5MTa4xstm2vCcH2p2ov3BeqpgtGLe5';
const PAYOUT_SCRIPT = '76a914805c4f5013f27e0b6f44a7f431b2c58c1b226d4688ac';
const PLACEHOLDER = '76a914000000000000000000000000000000000000000188ac';
const OWNER_SCRIPT = '76a914111111111111111111111111111111111111111188ac';
const ORIGIN = 'e17d7856c375640427943395d2341b6ed75f73afc8b22bb3681987278978a584_0';
const STRONG_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0';
const REMOTE_DB = 'postgresql://u:p@db.example.com:5432/postgres';

describe('Platform payout destination (mainnet P2PKH)', () => {
  it('derives and round-trips the verified mainnet payout script', () => {
    const result = deriveVerifiedMainnetPayoutScript(PAYOUT_ADDRESS);
    expect(result.lockingScriptHex).toBe(PAYOUT_SCRIPT);
    expect(result.publicKeyHashHex).toBe('805c4f5013f27e0b6f44a7f431b2c58c1b226d46');
    expect(result.lockingScriptHex).toHaveLength(50);
    expect(result.lockingScriptHex.startsWith('76a914')).toBe(true);
    expect(result.lockingScriptHex.endsWith('88ac')).toBe(true);
    expect(mainnetAddressFromPayoutScript(PAYOUT_SCRIPT)).toBe(PAYOUT_ADDRESS);
  });

  it('rejects invalid mainnet addresses (bad checksum, garbage, empty)', () => {
    for (const bad of [
      '1Chi5MTa4xstm2vCcH2p2ov3BeqpgtGLe6',
      '1Chi5MTa4xstm2vCcH2p2ov3BeqpgtGLe',
      'not-an-address',
      '0OIl',
      '',
    ]) {
      expect(() => deriveVerifiedMainnetPayoutScript(bad)).toThrow();
    }
  });

  it('rejects testnet addresses', () => {
    expect(() =>
      deriveVerifiedMainnetPayoutScript('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')
    ).toThrow(/testnet/i);
  });

  it('rejects P2SH-style (non-P2PKH version byte) addresses', () => {
    expect(() =>
      deriveVerifiedMainnetPayoutScript('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')
    ).toThrow(/mainnet P2PKH/i);
  });

  it('rejects invalid, nonstandard, or wrong-length scripts', () => {
    for (const bad of [
      'deadbeef',
      '76a914' + '11'.repeat(19) + '88ac',
      '76a914' + '11'.repeat(21) + '88ac',
      '76a914' + '11'.repeat(20) + '88',
      'a914' + '11'.repeat(20) + '87',
      '',
    ]) {
      expect(() => mainnetAddressFromPayoutScript(bad)).toThrow();
      expect(() =>
        parseAppEnv({ PLATFORM_PAYOUT_SCRIPT: bad })
      ).toThrow(/standard P2PKH/i);
    }
  });

  it('accepts the verified script in mock and live mode, but never the placeholder in live mode', () => {
    expect(
      parseAppEnv({ PLATFORM_PAYOUT_SCRIPT: PAYOUT_SCRIPT }).PLATFORM_PAYOUT_SCRIPT
    ).toBe(PAYOUT_SCRIPT);
    expect(parseAppEnv({ PLATFORM_PAYOUT_SCRIPT: PLACEHOLDER }).APP_MODE).toBe('mock');

    const live = {
      APP_MODE: 'live',
      NEXT_PUBLIC_APP_MODE: 'live',
      BSV_NETWORK: 'main',
      DATABASE_URL: REMOTE_DB,
      SESSION_SECRET: STRONG_SECRET,
    };
    expect(() => parseAppEnv({ ...live, PLATFORM_PAYOUT_SCRIPT: PLACEHOLDER })).toThrow(
      /real platform-controlled/i
    );
    expect(() => parseAppEnv({ ...live })).toThrow(/real platform-controlled/i);
    expect(
      parseAppEnv({ ...live, PLATFORM_PAYOUT_SCRIPT: PAYOUT_SCRIPT }).PLATFORM_PAYOUT_SCRIPT
    ).toBe(PAYOUT_SCRIPT);
  });

  it('uses the configured payout script for the platform allocation, preserving totals and the 50% owner minimum', () => {
    const configured = parseAppEnv({ PLATFORM_PAYOUT_SCRIPT: PAYOUT_SCRIPT });
    for (const total of [10_000, 10_001, 9_999, 123_457]) {
      const intent = buildPaymentIntentSnapshot({
        userId: 'u1',
        communityId: 'c1',
        actionType: 'SUBMIT_PAID_ACTIVITY',
        totalSatoshis: total,
        ownerShareBps: configured.OWNER_SHARE_BPS,
        platformShareBps: configured.PLATFORM_SHARE_BPS,
        ownerPayoutScript: OWNER_SCRIPT,
        platformPayoutScript: configured.PLATFORM_PAYOUT_SCRIPT,
        nftOrigin: ORIGIN,
        ownerOutpointSnapshot: ORIGIN,
        policyVersion: 1,
      });
      expect(intent.platformPayoutScript).toBe(PAYOUT_SCRIPT);
      expect(intent.ownerPayoutScript).toBe(OWNER_SCRIPT);
      expect(intent.ownerSatoshis + intent.platformSatoshis).toBe(total);
      expect(intent.ownerSatoshis * 2).toBeGreaterThanOrEqual(total);
    }
  });

  it('never broadcasts in mock mode and requires explicit authorization on mainnet', async () => {
    const mockMain = parseAppEnv({
      APP_MODE: 'mock',
      NEXT_PUBLIC_APP_MODE: 'mock',
      BSV_NETWORK: 'main',
      ALLOW_MAINNET_BROADCAST: 'false',
      PLATFORM_PAYOUT_SCRIPT: PAYOUT_SCRIPT,
    });
    expect(canBroadcastTransaction(mockMain, 'main').allowed).toBe(false);
    expect(() => assertBroadcastAuthorized(mockMain, 'main')).toThrow();

    const mockMainAllowed = parseAppEnv({
      APP_MODE: 'mock',
      NEXT_PUBLIC_APP_MODE: 'mock',
      BSV_NETWORK: 'main',
      ALLOW_MAINNET_BROADCAST: 'true',
    });
    expect(canBroadcastTransaction(mockMainAllowed, 'main').allowed).toBe(false);

    const liveBase = {
      APP_MODE: 'live',
      NEXT_PUBLIC_APP_MODE: 'live',
      BSV_NETWORK: 'main',
      DATABASE_URL: REMOTE_DB,
      SESSION_SECRET: STRONG_SECRET,
      PLATFORM_PAYOUT_SCRIPT: PAYOUT_SCRIPT,
    };
    const liveBlocked = parseAppEnv({ ...liveBase, ALLOW_MAINNET_BROADCAST: 'false' });
    expect(canBroadcastTransaction(liveBlocked, 'main').allowed).toBe(false);
    await expect(
      new OneSatMintingAdapter({
        envSource: { ...liveBase, ALLOW_MAINNET_BROADCAST: 'false' },
      }).mintCommunityOrdinal({
        communityId: 'c1',
        name: 'Payout Gate',
        description: 'Mainnet gate check.',
        destinationP2PKHScript: OWNER_SCRIPT,
        network: 'main',
      })
    ).rejects.toMatchObject({ code: 'MAINNET_MINT_FORBIDDEN' });

    const liveAllowed = parseAppEnv({ ...liveBase, ALLOW_MAINNET_BROADCAST: 'true' });
    expect(canBroadcastTransaction(liveAllowed, 'main').allowed).toBe(true);
  });
});
