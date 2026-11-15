import { randomBytes, randomUUID } from 'node:crypto';
import type { WalletProviderType } from '@/types/wallet';

export type ChallengeErrorCode =
  | 'CHALLENGE_NOT_FOUND'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_REUSED'
  | 'DOMAIN_MISMATCH'
  | 'PROVIDER_MISMATCH'
  | 'SESSION_MISMATCH';

export class AuthChallengeError extends Error {
  public readonly code: ChallengeErrorCode;

  constructor(code: ChallengeErrorCode, message: string) {
    super(message);
    this.name = 'AuthChallengeError';
    this.code = code;
  }
}

export interface AuthChallengeRecord {
  id: string;
  nonce: string;
  domain: string;
  provider: WalletProviderType;
  sessionId?: string;
  userId?: string;
  challengeText: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt?: Date;
}

export interface CreateChallengeOptions {
  provider: WalletProviderType;
  domain: string;
  sessionId?: string;
  userId?: string;
  ttlMs?: number;
  now?: Date;
}

export interface ValidateChallengeOptions {
  challengeId: string;
  expectedDomain: string;
  expectedProvider?: WalletProviderType;
  expectedSessionId?: string;
  now?: Date;
}

export const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Formats a human-readable, domain-bound authentication challenge message.
 * Wallet adapters extract the `Nonce: <hex>` line as the BRC-100 keyID when signing.
 */
export function formatChallengeMessage(params: {
  domain: string;
  provider: WalletProviderType;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  sessionId?: string;
}): string {
  const lines = [
    'BSV Community Platform Authentication',
    `Domain: ${params.domain}`,
    `Provider: ${params.provider}`,
    `Nonce: ${params.nonce}`,
    `IssuedAt: ${params.issuedAt.toISOString()}`,
    `ExpiresAt: ${params.expiresAt.toISOString()}`,
  ];
  if (params.sessionId) {
    lines.push(`SessionBinding: ${params.sessionId}`);
  }
  lines.push(
    'Statement: Sign this single-use challenge to verify ownership of your BSV wallet identity. No transaction will be broadcast and no funds will be spent.'
  );
  return lines.join('\n');
}

/**
 * Manages single-use, domain-bound, time-limited authentication challenges.
 */
export class ChallengeStore {
  private readonly challenges = new Map<string, AuthChallengeRecord>();

  public issueChallenge(options: CreateChallengeOptions): AuthChallengeRecord {
    const issuedAt = options.now ? new Date(options.now.getTime()) : new Date();
    const ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    const expiresAt = new Date(issuedAt.getTime() + ttlMs);
    const id = randomUUID();
    const nonce = randomBytes(32).toString('hex');
    const normalizedDomain = options.domain.trim().toLowerCase();

    const challengeText = formatChallengeMessage({
      domain: normalizedDomain,
      provider: options.provider,
      nonce,
      issuedAt,
      expiresAt,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    });

    const record: AuthChallengeRecord = {
      id,
      nonce,
      domain: normalizedDomain,
      provider: options.provider,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
      challengeText,
      issuedAt,
      expiresAt,
    };

    this.challenges.set(id, record);
    return { ...record };
  }

  public getChallenge(challengeId: string): AuthChallengeRecord | undefined {
    const record = this.challenges.get(challengeId);
    return record ? { ...record } : undefined;
  }

  /**
   * Validates that a challenge exists, has not been used, has not expired,
   * and matches the expected domain, provider, and optional session binding.
   */
  public validateChallenge(options: ValidateChallengeOptions): AuthChallengeRecord {
    const record = this.challenges.get(options.challengeId);
    if (!record) {
      throw new AuthChallengeError(
        'CHALLENGE_NOT_FOUND',
        `Authentication challenge '${options.challengeId}' was not found.`
      );
    }

    if (record.usedAt) {
      throw new AuthChallengeError(
        'CHALLENGE_REUSED',
        `Authentication challenge '${options.challengeId}' has already been consumed.`
      );
    }

    const now = options.now ?? new Date();
    if (now.getTime() > record.expiresAt.getTime()) {
      throw new AuthChallengeError(
        'CHALLENGE_EXPIRED',
        `Authentication challenge '${options.challengeId}' expired at ${record.expiresAt.toISOString()}.`
      );
    }

    const normalizedExpectedDomain = options.expectedDomain.trim().toLowerCase();
    if (record.domain !== normalizedExpectedDomain) {
      throw new AuthChallengeError(
        'DOMAIN_MISMATCH',
        `Authentication challenge domain mismatch: expected '${normalizedExpectedDomain}', got '${record.domain}'.`
      );
    }

    if (options.expectedProvider && record.provider !== options.expectedProvider) {
      throw new AuthChallengeError(
        'PROVIDER_MISMATCH',
        `Authentication challenge provider mismatch: expected '${options.expectedProvider}', got '${record.provider}'.`
      );
    }

    if (record.sessionId && record.sessionId !== options.expectedSessionId) {
      throw new AuthChallengeError(
        'SESSION_MISMATCH',
        'Authentication challenge is bound to a different session.'
      );
    }

    return { ...record };
  }

  /**
   * Marks a challenge as consumed so it can never be replayed.
   */
  public consumeChallenge(challengeId: string, now?: Date): AuthChallengeRecord {
    const record = this.challenges.get(challengeId);
    if (!record) {
      throw new AuthChallengeError(
        'CHALLENGE_NOT_FOUND',
        `Authentication challenge '${challengeId}' was not found.`
      );
    }
    if (record.usedAt) {
      throw new AuthChallengeError(
        'CHALLENGE_REUSED',
        `Authentication challenge '${challengeId}' has already been consumed.`
      );
    }
    record.usedAt = now ? new Date(now.getTime()) : new Date();
    return { ...record };
  }

  public clear(): void {
    this.challenges.clear();
  }
}
