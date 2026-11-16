import { describe, expect, it } from 'vitest';
import { OneSatMintingAdapter } from '@/adapters/ordinals/onesat-minting.adapter';
import {
  assertBroadcastAuthorized,
  assertLiveModeAuthorized,
  canBroadcastTransaction,
  DEV_DEFAULT_SESSION_SECRET,
  LOCAL_DEV_DATABASE_URL,
  parseAppEnv,
  resolveDatabaseUrl,
  resolveMigrationDatabaseUrl,
  resolveValidatedSessionSecret,
} from '@/lib/config/env';

describe('Environment Configuration & Mock Mode Safeguards', () => {
  it('defaults APP_MODE and NEXT_PUBLIC_APP_MODE to "mock", BSV_NETWORK to "test", and ALLOW_MAINNET_BROADCAST to false', () => {
    const config = parseAppEnv({});
    expect(config.APP_MODE).toBe('mock');
    expect(config.NEXT_PUBLIC_APP_MODE).toBe('mock');
    expect(config.BSV_NETWORK).toBe('test');
    expect(config.ALLOW_MAINNET_BROADCAST).toBe(false);
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
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app',
      SESSION_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
      PLATFORM_PAYOUT_SCRIPT: '76a9147d3b9a1e5c2f4a6b8c0d1e2f3a4b5c6d7e8f9a0b88ac',
    });
    expect(prodConfig.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it('requires explicit non-local DATABASE_URL in production/live and keeps the local fallback only for development', () => {
    const strongSecret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0';

    expect(() =>
      parseAppEnv({ NODE_ENV: 'production', SESSION_SECRET: strongSecret })
    ).toThrow(/DATABASE_URL must be explicitly configured/i);

    expect(() =>
      parseAppEnv({
        NODE_ENV: 'production',
        SESSION_SECRET: strongSecret,
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/x',
      })
    ).toThrow(/must not point to localhost/i);

    expect(() => resolveDatabaseUrl(undefined, { APP_MODE: 'live' })).toThrow(
      /explicitly configured/i
    );
    expect(() => resolveDatabaseUrl(undefined, { NODE_ENV: 'production' })).toThrow(
      /explicitly configured/i
    );

    // Development / mock mode keeps the local fallback
    expect(resolveDatabaseUrl(undefined, {})).toBe(LOCAL_DEV_DATABASE_URL);
    expect(parseAppEnv({}).DATABASE_URL).toBe(LOCAL_DEV_DATABASE_URL);
  });

  it('rejects missing or localhost DIRECT_URL / DATABASE_URL in migration config for production or live mode', () => {
    expect(() =>
      resolveMigrationDatabaseUrl(undefined, { NODE_ENV: 'production' })
    ).toThrow(/DIRECT_URL \(or DATABASE_URL\) must be explicitly configured/i);

    expect(() =>
      resolveMigrationDatabaseUrl(undefined, { APP_MODE: 'live' })
    ).toThrow(/DIRECT_URL \(or DATABASE_URL\) must be explicitly configured/i);

    expect(() =>
      resolveMigrationDatabaseUrl(
        'postgresql://postgres:postgres@localhost:5432/community_nft_poc',
        { NODE_ENV: 'production' }
      )
    ).toThrow(/must not point to localhost/i);

    expect(() =>
      resolveMigrationDatabaseUrl(
        'postgresql://postgres:postgres@127.0.0.1:5432/community_nft_poc',
        { APP_MODE: 'live' }
      )
    ).toThrow(/must not point to localhost/i);

    expect(
      resolveMigrationDatabaseUrl(
        'postgresql://u:p@db.example.com:5432/postgres',
        { NODE_ENV: 'production', APP_MODE: 'live' }
      )
    ).toBe('postgresql://u:p@db.example.com:5432/postgres');
  });

  it('enforces mainnet and broadcast safety across all 8 combinations of (APP_MODE, BSV_NETWORK, ALLOW_MAINNET_BROADCAST)', async () => {
    const strongSecret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0';
    const remoteDb = 'postgresql://u:p@db.example.com:5432/postgres';

    const matrix: Array<{
      appMode: 'mock' | 'live';
      bsvNetwork: 'test' | 'main';
      allowMainnetBroadcast: 'false' | 'true';
      expectTestBroadcastAllowed: boolean;
      expectMainBroadcastAllowed: boolean;
    }> = [
      // Mock mode NEVER broadcasts real transactions regardless of BSV_NETWORK or ALLOW_MAINNET_BROADCAST
      {
        appMode: 'mock',
        bsvNetwork: 'test',
        allowMainnetBroadcast: 'false',
        expectTestBroadcastAllowed: false,
        expectMainBroadcastAllowed: false,
      },
      {
        appMode: 'mock',
        bsvNetwork: 'test',
        allowMainnetBroadcast: 'true',
        expectTestBroadcastAllowed: false,
        expectMainBroadcastAllowed: false,
      },
      {
        appMode: 'mock',
        bsvNetwork: 'main',
        allowMainnetBroadcast: 'false',
        expectTestBroadcastAllowed: false,
        expectMainBroadcastAllowed: false,
      },
      {
        appMode: 'mock',
        bsvNetwork: 'main',
        allowMainnetBroadcast: 'true',
        expectTestBroadcastAllowed: false,
        expectMainBroadcastAllowed: false,
      },
      // Live + testnet allows testnet broadcast ONLY (blocks mainnet broadcast regardless of ALLOW_MAINNET_BROADCAST)
      {
        appMode: 'live',
        bsvNetwork: 'test',
        allowMainnetBroadcast: 'false',
        expectTestBroadcastAllowed: true,
        expectMainBroadcastAllowed: false,
      },
      {
        appMode: 'live',
        bsvNetwork: 'test',
        allowMainnetBroadcast: 'true',
        expectTestBroadcastAllowed: true,
        expectMainBroadcastAllowed: false,
      },
      // Live + mainnet requires ALLOW_MAINNET_BROADCAST="true"
      {
        appMode: 'live',
        bsvNetwork: 'main',
        allowMainnetBroadcast: 'false',
        expectTestBroadcastAllowed: false,
        expectMainBroadcastAllowed: false,
      },
      {
        appMode: 'live',
        bsvNetwork: 'main',
        allowMainnetBroadcast: 'true',
        expectTestBroadcastAllowed: false,
        expectMainBroadcastAllowed: true,
      },
    ];

    for (const row of matrix) {
      const envSource: Record<string, string> = {
        APP_MODE: row.appMode,
        NEXT_PUBLIC_APP_MODE: row.appMode,
        BSV_NETWORK: row.bsvNetwork,
        ALLOW_MAINNET_BROADCAST: row.allowMainnetBroadcast,
        ...(row.appMode === 'live'
          ? {
              DATABASE_URL: remoteDb,
              SESSION_SECRET: strongSecret,
              PLATFORM_PAYOUT_SCRIPT: '76a9147d3b9a1e5c2f4a6b8c0d1e2f3a4b5c6d7e8f9a0b88ac',
            }
          : {}),
      };

      const config = parseAppEnv(envSource);
      expect(config.APP_MODE).toBe(row.appMode);
      expect(config.BSV_NETWORK).toBe(row.bsvNetwork);
      expect(config.ALLOW_MAINNET_BROADCAST).toBe(
        row.allowMainnetBroadcast === 'true'
      );

      const testVerdict = canBroadcastTransaction(config, 'test');
      expect(testVerdict.allowed).toBe(row.expectTestBroadcastAllowed);
      if (row.expectTestBroadcastAllowed) {
        expect(() => assertBroadcastAuthorized(config, 'test')).not.toThrow();
      } else {
        expect(() => assertBroadcastAuthorized(config, 'test')).toThrow();
      }

      const mainVerdict = canBroadcastTransaction(config, 'main');
      expect(mainVerdict.allowed).toBe(row.expectMainBroadcastAllowed);
      if (row.expectMainBroadcastAllowed) {
        expect(() => assertBroadcastAuthorized(config, 'main')).not.toThrow();
      } else {
        expect(() => assertBroadcastAuthorized(config, 'main')).toThrow();
      }

      // Also verify OneSatMintingAdapter enforces these exact safeguards before requiring a wallet substrate
      const adapter = new OneSatMintingAdapter({ envSource });
      const attempt = adapter.mintCommunityOrdinal({
        communityId: 'comm-matrix-check',
        name: 'Matrix Safety Test',
        description: 'Testing network broadcast safety combinations.',
        destinationP2PKHScript:
          '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac',
        network: row.bsvNetwork,
      });

      if (row.appMode === 'mock') {
        await expect(attempt).rejects.toThrow(/disabled while APP_MODE is "mock"/i);
      } else if (row.bsvNetwork === 'main' && row.allowMainnetBroadcast === 'false') {
        await expect(attempt).rejects.toMatchObject({
          code: 'MAINNET_MINT_FORBIDDEN',
          statusCode: 403,
        });
      } else {
        // Reaches wallet check because network safety gate passed (requires live wallet substrate)
        await expect(attempt).rejects.toMatchObject({
          code: 'WALLET_SUBSTRATE_REQUIRED',
        });
      }
    }
  });

  it('rejects the placeholder PLATFORM_PAYOUT_SCRIPT in live mode but keeps it as the mock/dev default', () => {
    const liveBase = {
      APP_MODE: 'live',
      NEXT_PUBLIC_APP_MODE: 'live',
      DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app',
      SESSION_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
    };

    // Unset in live mode falls back to the placeholder default and must be rejected
    expect(() => parseAppEnv(liveBase)).toThrow(/PLATFORM_PAYOUT_SCRIPT must be set/i);

    for (const placeholder of [
      '76a914000000000000000000000000000000000000000188ac',
      '76a914000000000000000000000000000000000000000088ac',
      '76A914000000000000000000000000000000000000000188AC',
    ]) {
      expect(() =>
        parseAppEnv({ ...liveBase, PLATFORM_PAYOUT_SCRIPT: placeholder })
      ).toThrow(/PLATFORM_PAYOUT_SCRIPT must be set/i);
    }

    const realScript = '76a9147d3b9a1e5c2f4a6b8c0d1e2f3a4b5c6d7e8f9a0b88ac';
    expect(
      parseAppEnv({ ...liveBase, PLATFORM_PAYOUT_SCRIPT: realScript })
        .PLATFORM_PAYOUT_SCRIPT
    ).toBe(realScript);

    // Mock mode (including a mock production build, as in CI) keeps the safe placeholder default
    expect(parseAppEnv({}).PLATFORM_PAYOUT_SCRIPT).toBe(
      '76a914000000000000000000000000000000000000000188ac'
    );
    expect(() =>
      parseAppEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app',
        SESSION_SECRET: liveBase.SESSION_SECRET,
      })
    ).not.toThrow();
  });
});
