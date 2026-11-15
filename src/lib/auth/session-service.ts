import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PrismaClient, AuthSession as PrismaAuthSession } from '@/generated/prisma/client';
import { resolveValidatedSessionSecret } from '@/lib/config/env';
import { prisma } from '@/lib/database/prisma';
import type { WalletProviderType } from '@/types/wallet';

export const SESSION_COOKIE_NAME = 'poc_session';
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type SessionErrorCode =
  | 'SESSION_MISSING'
  | 'SESSION_INVALID_SIGNATURE'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED';

export class AuthSessionError extends Error {
  public readonly code: SessionErrorCode;

  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = 'AuthSessionError';
    this.code = code;
  }
}

export interface ServerSessionRecord {
  sessionId: string;
  userId: string;
  activeWalletConnectionId: string;
  provider: WalletProviderType;
  identityKey: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface CreateSessionOptions {
  userId: string;
  activeWalletConnectionId: string;
  provider: WalletProviderType;
  identityKey: string;
  ttlMs?: number;
  now?: Date;
}

export interface CookieOptions {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  maxAge: number;
  expires: Date;
}

function mapSessionRow(row: PrismaAuthSession): ServerSessionRecord {
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    activeWalletConnectionId: row.activeWalletConnectionId,
    provider: row.provider,
    identityKey: row.identityKey,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

export interface SessionStoreOptions {
  secret?: string;
  prisma?: PrismaClient;
  envSource?: Record<string, string | undefined>;
}

/**
 * Persistent server-side session manager backed by PostgreSQL (`auth_sessions`)
 * with HMAC-SHA256 signed tokens, strict secret validation, and expiration/revocation enforcement.
 */
export class SessionStore {
  private readonly prisma: PrismaClient;
  private readonly secret: string;
  private readonly isSecureCookie: boolean;

  constructor(options?: string | SessionStoreOptions) {
    const opts: SessionStoreOptions =
      typeof options === 'string' ? { secret: options } : (options ?? {});
    const envSource = opts.envSource ?? process.env;
    this.secret = resolveValidatedSessionSecret(opts.secret, envSource);
    this.prisma = opts.prisma ?? prisma;
    this.isSecureCookie =
      envSource.NODE_ENV === 'production' || envSource.APP_MODE === 'live';
  }

  private signSessionId(sessionId: string): string {
    return createHmac('sha256', this.secret).update(sessionId).digest('hex');
  }

  public async createSession(options: CreateSessionOptions): Promise<{
    token: string;
    session: ServerSessionRecord;
    cookie: CookieOptions;
  }> {
    const issuedAt = options.now ? new Date(options.now.getTime()) : new Date();
    const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    const expiresAt = new Date(issuedAt.getTime() + ttlMs);
    const sessionId = randomUUID();

    const created = await this.prisma.authSession.create({
      data: {
        sessionId,
        userId: options.userId,
        activeWalletConnectionId: options.activeWalletConnectionId,
        provider: options.provider,
        identityKey: options.identityKey,
        issuedAt,
        expiresAt,
      },
    });

    const signature = this.signSessionId(sessionId);
    const token = `${sessionId}.${signature}`;
    const maxAgeSeconds = Math.max(0, Math.floor(ttlMs / 1000));

    return {
      token,
      session: mapSessionRow(created),
      cookie: {
        name: SESSION_COOKIE_NAME,
        value: token,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: this.isSecureCookie,
        maxAge: maxAgeSeconds,
        expires: expiresAt,
      },
    };
  }

  /**
   * Verifies a signed session token and returns the active server-side session record from PostgreSQL.
   */
  public async verifySessionToken(
    token: string | undefined | null,
    now?: Date
  ): Promise<ServerSessionRecord> {
    if (!token || typeof token !== 'string' || !token.includes('.')) {
      throw new AuthSessionError('SESSION_MISSING', 'Missing or malformed session token.');
    }

    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new AuthSessionError('SESSION_MISSING', 'Malformed session token.');
    }

    const [sessionId, providedSig] = parts;
    const expectedSig = this.signSessionId(sessionId);

    const providedBuf = Buffer.from(providedSig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (
      providedBuf.length !== expectedBuf.length ||
      !timingSafeEqual(providedBuf, expectedBuf)
    ) {
      throw new AuthSessionError(
        'SESSION_INVALID_SIGNATURE',
        'Session token HMAC signature verification failed.'
      );
    }

    const record = await this.prisma.authSession.findUnique({
      where: { sessionId },
    });
    if (!record) {
      throw new AuthSessionError('SESSION_NOT_FOUND', 'Server session was not found.');
    }

    if (record.revokedAt) {
      throw new AuthSessionError('SESSION_REVOKED', 'Session has been revoked.');
    }

    const currentTime = now ?? new Date();
    if (currentTime.getTime() > record.expiresAt.getTime()) {
      throw new AuthSessionError(
        'SESSION_EXPIRED',
        `Session expired at ${record.expiresAt.toISOString()}.`
      );
    }

    return mapSessionRow(record);
  }

  /**
   * Updates the active wallet connection on an existing session (e.g., when linking an additional wallet).
   */
  public async updateActiveWallet(
    sessionId: string,
    update: {
      activeWalletConnectionId: string;
      provider: WalletProviderType;
      identityKey: string;
    }
  ): Promise<ServerSessionRecord> {
    const existing = await this.prisma.authSession.findUnique({
      where: { sessionId },
    });
    if (!existing) {
      throw new AuthSessionError('SESSION_NOT_FOUND', 'Server session was not found.');
    }
    const updated = await this.prisma.authSession.update({
      where: { sessionId },
      data: {
        activeWalletConnectionId: update.activeWalletConnectionId,
        provider: update.provider,
        identityKey: update.identityKey,
      },
    });
    return mapSessionRow(updated);
  }

  /**
   * Revokes a session in PostgreSQL by token or session ID.
   */
  public async revokeSession(tokenOrSessionId: string, now?: Date): Promise<void> {
    const sessionId = tokenOrSessionId.includes('.')
      ? tokenOrSessionId.split('.')[0] ?? tokenOrSessionId
      : tokenOrSessionId;
    if (!sessionId) {
      return;
    }
    const revokedAt = now ? new Date(now.getTime()) : new Date();
    await this.prisma.authSession.updateMany({
      where: {
        sessionId,
        revokedAt: null,
      },
      data: {
        revokedAt,
      },
    });
  }

  /**
   * Revokes all active sessions associated with a specific walletConnectionId.
   */
  public async revokeSessionsByWalletConnection(
    walletConnectionId: string,
    now?: Date
  ): Promise<void> {
    const revokedAt = now ? new Date(now.getTime()) : new Date();
    await this.prisma.authSession.updateMany({
      where: {
        activeWalletConnectionId: walletConnectionId,
        revokedAt: null,
      },
      data: {
        revokedAt,
      },
    });
  }

  public buildExpiredCookie(): CookieOptions {
    return {
      name: SESSION_COOKIE_NAME,
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: this.isSecureCookie,
      maxAge: 0,
      expires: new Date(0),
    };
  }

  public async clear(): Promise<void> {
    await this.prisma.authSession.deleteMany();
  }
}
