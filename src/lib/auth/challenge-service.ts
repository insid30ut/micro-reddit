import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient, AuthChallenge as PrismaAuthChallenge } from '@/generated/prisma/client';
import { prisma } from '@/lib/database/prisma';
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

function mapChallengeRow(row: PrismaAuthChallenge): AuthChallengeRecord {
  return {
    id: row.id,
    nonce: row.nonce,
    domain: row.domain,
    provider: row.provider,
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.userId ? { userId: row.userId } : {}),
    challengeText: row.challengeText,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    ...(row.usedAt ? { usedAt: row.usedAt } : {}),
  };
}

/**
 * Manages single-use, domain-bound, time-limited authentication challenges persisted in PostgreSQL.
 */
export class ChallengeStore {
  private readonly prisma: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.prisma = prismaClient;
  }

  public async issueChallenge(options: CreateChallengeOptions): Promise<AuthChallengeRecord> {
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

    const created = await this.prisma.authChallenge.create({
      data: {
        id,
        nonce,
        domain: normalizedDomain,
        provider: options.provider,
        sessionId: options.sessionId ?? null,
        userId: options.userId ?? null,
        challengeText,
        issuedAt,
        expiresAt,
      },
    });

    return mapChallengeRow(created);
  }

  public async getChallenge(challengeId: string): Promise<AuthChallengeRecord | undefined> {
    const row = await this.prisma.authChallenge.findUnique({
      where: { id: challengeId },
    });
    return row ? mapChallengeRow(row) : undefined;
  }

  /**
   * Validates that a challenge exists, has not been used, has not expired,
   * and matches the expected domain, provider, and optional session binding.
   */
  public async validateChallenge(options: ValidateChallengeOptions): Promise<AuthChallengeRecord> {
    const row = await this.prisma.authChallenge.findUnique({
      where: { id: options.challengeId },
    });
    if (!row) {
      throw new AuthChallengeError(
        'CHALLENGE_NOT_FOUND',
        `Authentication challenge '${options.challengeId}' was not found.`
      );
    }

    if (row.usedAt) {
      throw new AuthChallengeError(
        'CHALLENGE_REUSED',
        `Authentication challenge '${options.challengeId}' has already been consumed.`
      );
    }

    const now = options.now ?? new Date();
    if (now.getTime() > row.expiresAt.getTime()) {
      throw new AuthChallengeError(
        'CHALLENGE_EXPIRED',
        `Authentication challenge '${options.challengeId}' expired at ${row.expiresAt.toISOString()}.`
      );
    }

    const normalizedExpectedDomain = options.expectedDomain.trim().toLowerCase();
    if (row.domain !== normalizedExpectedDomain) {
      throw new AuthChallengeError(
        'DOMAIN_MISMATCH',
        `Authentication challenge domain mismatch: expected '${normalizedExpectedDomain}', got '${row.domain}'.`
      );
    }

    if (options.expectedProvider && row.provider !== options.expectedProvider) {
      throw new AuthChallengeError(
        'PROVIDER_MISMATCH',
        `Authentication challenge provider mismatch: expected '${options.expectedProvider}', got '${row.provider}'.`
      );
    }

    if (row.sessionId && row.sessionId !== options.expectedSessionId) {
      throw new AuthChallengeError(
        'SESSION_MISMATCH',
        'Authentication challenge is bound to a different session.'
      );
    }

    return mapChallengeRow(row);
  }

  /**
   * Atomically marks a challenge as consumed so concurrent or sequential replay attempts fail.
   */
  public async consumeChallenge(challengeId: string, now?: Date): Promise<AuthChallengeRecord> {
    const consumedAt = now ? new Date(now.getTime()) : new Date();
    const updated = await this.prisma.authChallenge.updateMany({
      where: {
        id: challengeId,
        usedAt: null,
        expiresAt: { gte: consumedAt },
      },
      data: {
        usedAt: consumedAt,
      },
    });

    if (updated.count !== 1) {
      const existing = await this.prisma.authChallenge.findUnique({
        where: { id: challengeId },
      });
      if (!existing) {
        throw new AuthChallengeError(
          'CHALLENGE_NOT_FOUND',
          `Authentication challenge '${challengeId}' was not found.`
        );
      }
      if (existing.usedAt) {
        throw new AuthChallengeError(
          'CHALLENGE_REUSED',
          `Authentication challenge '${challengeId}' has already been consumed.`
        );
      }
      throw new AuthChallengeError(
        'CHALLENGE_EXPIRED',
        `Authentication challenge '${challengeId}' expired at ${existing.expiresAt.toISOString()}.`
      );
    }

    const consumed = await this.prisma.authChallenge.findUniqueOrThrow({
      where: { id: challengeId },
    });
    return mapChallengeRow(consumed);
  }

  public async clear(): Promise<void> {
    await this.prisma.authChallenge.deleteMany();
  }
}
