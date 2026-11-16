import { z } from 'zod';
import { isStandardP2PKHScript } from '@/lib/ordinals/script-parser';

export const DEV_DEFAULT_SESSION_SECRET =
  'development-only-session-secret-change-in-production-32chars';

/**
 * Placeholder P2PKH scripts whose 20-byte key hash is not a real wallet key (nobody can spend
 * outputs sent to them). Acceptable as a local/mock default, never as a live revenue destination.
 */
export const DEV_PLACEHOLDER_PLATFORM_PAYOUT_SCRIPTS = new Set<string>([
  '76a914000000000000000000000000000000000000000188ac',
  '76a914000000000000000000000000000000000000000088ac',
]);

export const DEV_PLACEHOLDER_SESSION_SECRETS = new Set<string>([
  DEV_DEFAULT_SESSION_SECRET,
  'dev-mock-mode-session-secret-minimum-32-characters-long',
]);

/**
 * Resolves and validates the server session signing secret.
 * Never allows missing, weak (< 32 chars), or placeholder secrets in production or live mode.
 */
export function resolveValidatedSessionSecret(
  explicitSecret?: string,
  envSource: Record<string, string | undefined> = process.env
): string {
  const isStrictProduction =
    envSource.NODE_ENV === 'production' || envSource.APP_MODE === 'live';
  const candidate =
    explicitSecret !== undefined ? explicitSecret : envSource.SESSION_SECRET;

  if (candidate === undefined) {
    if (isStrictProduction) {
      throw new Error(
        'SESSION_SECRET must be explicitly configured (minimum 32 characters) when NODE_ENV=production or APP_MODE=live.'
      );
    }
    return DEV_DEFAULT_SESSION_SECRET;
  }

  if (candidate.trim().length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters long.');
  }

  if (isStrictProduction && DEV_PLACEHOLDER_SESSION_SECRETS.has(candidate)) {
    throw new Error(
      'SESSION_SECRET must not use a development placeholder value when NODE_ENV=production or APP_MODE=live.'
    );
  }

  return candidate;
}

export const LOCAL_DEV_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/community_nft_poc?schema=public';

/**
 * Resolves the runtime database URL. The local development fallback is allowed only
 * outside production/live mode; production must configure DATABASE_URL explicitly.
 */
export function resolveDatabaseUrl(
  explicitUrl?: string,
  envSource: Record<string, string | undefined> = process.env
): string {
  const isStrictProduction =
    envSource.NODE_ENV === 'production' || envSource.APP_MODE === 'live';
  const candidate = explicitUrl ?? envSource.DATABASE_URL;
  if (candidate && candidate.trim().length > 0) {
    if (isStrictProduction && /@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(candidate)) {
      throw new Error(
        'DATABASE_URL must not point to localhost when NODE_ENV=production or APP_MODE=live.'
      );
    }
    return candidate;
  }
  if (isStrictProduction) {
    throw new Error(
      'DATABASE_URL must be explicitly configured when NODE_ENV=production or APP_MODE=live (no local fallback).'
    );
  }
  return LOCAL_DEV_DATABASE_URL;
}

/**
 * Resolves the Prisma migration database URL (DIRECT_URL preferred, falling back to DATABASE_URL).
 * Rejects missing or localhost URLs when NODE_ENV=production or APP_MODE=live.
 */
export function resolveMigrationDatabaseUrl(
  explicitUrl?: string,
  envSource: Record<string, string | undefined> = process.env
): string {
  const isStrictProduction =
    envSource.NODE_ENV === 'production' || envSource.APP_MODE === 'live';
  const candidate =
    explicitUrl ?? envSource.DIRECT_URL ?? envSource.DATABASE_URL;

  if (candidate && candidate.trim().length > 0) {
    if (isStrictProduction && /@(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(candidate)) {
      throw new Error(
        'DIRECT_URL (or DATABASE_URL) must not point to localhost when NODE_ENV=production or APP_MODE=live.'
      );
    }
    return candidate;
  }

  if (isStrictProduction) {
    throw new Error(
      'DIRECT_URL (or DATABASE_URL) must be explicitly configured in production/live mode; no local fallback.'
    );
  }

  return LOCAL_DEV_DATABASE_URL;
}

const rawEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
    DATABASE_URL: z.string().optional(),
    DIRECT_URL: z
      .string()
      .optional(),
    NEXT_PUBLIC_SUPABASE_URL: z
      .string()
      .url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL')
      .optional(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
      .string()
      .min(1)
      .optional(),
    NEXT_PUBLIC_APP_URL: z
      .string()
      .url('NEXT_PUBLIC_APP_URL must be a valid URL')
      .default('http://localhost:3000'),
    APP_MODE: z.enum(['mock', 'live']).default('mock'),
    NEXT_PUBLIC_APP_MODE: z.enum(['mock', 'live']).default('mock'),
    BSV_NETWORK: z.enum(['main', 'test']).default('test'),
    ALLOW_MAINNET_BROADCAST: z
      .enum(['true', 'false'])
      .default('false')
      .transform((val) => val === 'true'),
    ALLOWED_AUTH_DOMAINS: z.string().optional().default(''),
    TRUST_PROXY_HEADERS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((val) => val === 'true'),
    PLATFORM_PAYOUT_SCRIPT: z
      .string()
      .refine(
        (val) => isStandardP2PKHScript(val),
        'PLATFORM_PAYOUT_SCRIPT must be a valid 25-byte standard P2PKH locking script in hex (76a914<20-byte-pkh>88ac)'
      )
      .default('76a914000000000000000000000000000000000000000188ac'),
    OWNER_SHARE_BPS: z.coerce
      .number()
      .int()
      .min(5000, 'OWNER_SHARE_BPS must be at least 5000 (50%)')
      .max(10000, 'OWNER_SHARE_BPS cannot exceed 10000 (100%)')
      .default(7000),
    PLATFORM_SHARE_BPS: z.coerce
      .number()
      .int()
      .min(0, 'PLATFORM_SHARE_BPS must be non-negative')
      .max(5000, 'PLATFORM_SHARE_BPS cannot exceed 5000 (50%)')
      .default(3000),
    ACTIVITY_FEE_SATS: z.coerce
      .number()
      .int()
      .min(100, 'ACTIVITY_FEE_SATS must be at least 100 satoshis')
      .default(10000),
    PAYMENT_INTENT_EXPIRY_SECONDS: z.coerce
      .number()
      .int()
      .min(30, 'PAYMENT_INTENT_EXPIRY_SECONDS must be at least 30 seconds')
      .max(3600, 'PAYMENT_INTENT_EXPIRY_SECONDS cannot exceed 3600 seconds')
      .default(120),
    OWNERSHIP_CONFIRMATIONS_REQUIRED: z.coerce
      .number()
      .int()
      .min(1, 'OWNERSHIP_CONFIRMATIONS_REQUIRED must be at least 1 so mempool transfers cannot prematurely switch ownership')
      .default(1),
    PAYMENT_CONFIRMATIONS_REQUIRED: z.coerce
      .number()
      .int()
      .min(1, 'PAYMENT_CONFIRMATIONS_REQUIRED must be at least 1 so observed 0-conf transactions cannot prematurely authorize paid activities')
      .default(1),
    ONESAT_API_BASE_URL: z
      .string()
      .url('ONESAT_API_BASE_URL must be a valid URL')
      .default('https://api.1sat.app'),
    SESSION_SECRET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.OWNER_SHARE_BPS + env.PLATFORM_SHARE_BPS !== 10000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['OWNER_SHARE_BPS'],
        message: `OWNER_SHARE_BPS (${env.OWNER_SHARE_BPS}) + PLATFORM_SHARE_BPS (${env.PLATFORM_SHARE_BPS}) must equal 10000.`,
      });
    }
    if (env.APP_MODE !== env.NEXT_PUBLIC_APP_MODE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEXT_PUBLIC_APP_MODE'],
        message: `APP_MODE ("${env.APP_MODE}") and NEXT_PUBLIC_APP_MODE ("${env.NEXT_PUBLIC_APP_MODE}") must match.`,
      });
    }

    if (
      env.APP_MODE === 'live' &&
      DEV_PLACEHOLDER_PLATFORM_PAYOUT_SCRIPTS.has(
        env.PLATFORM_PAYOUT_SCRIPT.trim().toLowerCase()
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PLATFORM_PAYOUT_SCRIPT'],
        message:
          'PLATFORM_PAYOUT_SCRIPT must be set to a real platform-controlled P2PKH locking script when APP_MODE=live; the development placeholder sends revenue to a key nobody controls.',
      });
    }

    const isStrictProduction =
      env.NODE_ENV === 'production' || env.APP_MODE === 'live';

    if (isStrictProduction) {
      try {
        resolveDatabaseUrl(env.DATABASE_URL, {
          NODE_ENV: env.NODE_ENV,
          APP_MODE: env.APP_MODE,
        });
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message: e instanceof Error ? e.message : 'Invalid DATABASE_URL.',
        });
      }
      if (!env.SESSION_SECRET || env.SESSION_SECRET.trim().length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_SECRET'],
          message:
            'SESSION_SECRET is required and must be at least 32 characters long when NODE_ENV=production or APP_MODE=live.',
        });
      } else if (DEV_PLACEHOLDER_SESSION_SECRETS.has(env.SESSION_SECRET)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_SECRET'],
          message:
            'SESSION_SECRET cannot use a development placeholder value when NODE_ENV=production or APP_MODE=live.',
        });
      }
    } else if (
      env.SESSION_SECRET !== undefined &&
      env.SESSION_SECRET.trim().length < 32
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_SECRET'],
        message: 'SESSION_SECRET must be at least 32 characters long.',
      });
    }
  })
  .transform((env) => ({
    ...env,
    DATABASE_URL: env.DATABASE_URL?.trim() ? env.DATABASE_URL : LOCAL_DEV_DATABASE_URL,
    SESSION_SECRET: env.SESSION_SECRET ?? DEV_DEFAULT_SESSION_SECRET,
  }));

export type AppEnvConfig = z.infer<typeof rawEnvSchema>;

/**
 * Validates an arbitrary environment map against the PoC configuration rules.
 * Defaults to MOCK mode (`APP_MODE="mock"`) so live mainnet operations are never enabled implicitly.
 */
export function parseAppEnv(source: Record<string, string | undefined> = process.env): AppEnvConfig {
  return rawEnvSchema.parse(source);
}

/**
 * Evaluates whether a blockchain transaction broadcast is permitted under the active
 * configuration and target network.
 *
 * Mainnet broadcasting requires ALL THREE flags:
 * - `APP_MODE === "live"`
 * - `BSV_NETWORK === "main"` (matching `targetNetwork`)
 * - `ALLOW_MAINNET_BROADCAST === true`
 *
 * Mock mode (`APP_MODE === "mock"`) never authorizes real transaction broadcasting.
 */
export function canBroadcastTransaction(
  config: AppEnvConfig,
  targetNetwork: 'main' | 'test' = config.BSV_NETWORK
): { allowed: boolean; reason?: string } {
  if (config.APP_MODE !== 'live') {
    return {
      allowed: false,
      reason:
        'Live blockchain broadcasting/minting/spending is disabled while APP_MODE is "mock". Explicit approval and live configuration are required.',
    };
  }

  if (targetNetwork !== config.BSV_NETWORK) {
    return {
      allowed: false,
      reason: `Target network "${targetNetwork}" does not match configured BSV_NETWORK "${config.BSV_NETWORK}".`,
    };
  }

  if (targetNetwork === 'main' && !config.ALLOW_MAINNET_BROADCAST) {
    return {
      allowed: false,
      reason:
        'Mainnet transaction broadcasting is disabled unless APP_MODE="live", BSV_NETWORK="main", and ALLOW_MAINNET_BROADCAST="true" are all explicitly configured.',
    };
  }

  return { allowed: true };
}

/**
 * Guard helper that throws if transaction broadcasting to `targetNetwork`
 * (defaulting to `config.BSV_NETWORK`) is not explicitly authorized.
 */
export function assertBroadcastAuthorized(
  config: AppEnvConfig = parseAppEnv(),
  targetNetwork: 'main' | 'test' = config.BSV_NETWORK
): void {
  const verdict = canBroadcastTransaction(config, targetNetwork);
  if (!verdict.allowed) {
    throw new Error(verdict.reason ?? 'Transaction broadcast is not authorized.');
  }
}

/**
 * Guard helper that throws if a live blockchain operation is attempted while in mock mode.
 */
export function assertLiveModeAuthorized(config: AppEnvConfig = parseAppEnv()): void {
  if (config.APP_MODE !== 'live') {
    throw new Error(
      'Live blockchain broadcasting/minting/spending is disabled while APP_MODE is "mock". Explicit approval and live configuration are required.'
    );
  }
}
