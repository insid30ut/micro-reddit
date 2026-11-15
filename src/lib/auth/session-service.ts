import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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

/**
 * Server-side session manager with HMAC-SHA256 signed tokens and expiration enforcement.
 */
export class SessionStore {
  private readonly sessions = new Map<string, ServerSessionRecord>();
  private readonly secret: string;

  constructor(secret?: string) {
    const resolvedSecret =
      secret ??
      process.env.SESSION_SECRET ??
      'dev-mock-mode-session-secret-minimum-32-characters-long';
    if (resolvedSecret.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters long.');
    }
    this.secret = resolvedSecret;
  }

  private signSessionId(sessionId: string): string {
    return createHmac('sha256', this.secret).update(sessionId).digest('hex');
  }

  public createSession(options: CreateSessionOptions): {
    token: string;
    session: ServerSessionRecord;
    cookie: CookieOptions;
  } {
    const issuedAt = options.now ? new Date(options.now.getTime()) : new Date();
    const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    const expiresAt = new Date(issuedAt.getTime() + ttlMs);
    const sessionId = randomUUID();

    const record: ServerSessionRecord = {
      sessionId,
      userId: options.userId,
      activeWalletConnectionId: options.activeWalletConnectionId,
      provider: options.provider,
      identityKey: options.identityKey,
      issuedAt,
      expiresAt,
    };

    this.sessions.set(sessionId, record);

    const signature = this.signSessionId(sessionId);
    const token = `${sessionId}.${signature}`;
    const maxAgeSeconds = Math.max(0, Math.floor(ttlMs / 1000));

    return {
      token,
      session: { ...record },
      cookie: {
        name: SESSION_COOKIE_NAME,
        value: token,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: maxAgeSeconds,
        expires: expiresAt,
      },
    };
  }

  /**
   * Verifies a signed session token and returns the active server-side session record.
   */
  public verifySessionToken(token: string | undefined | null, now?: Date): ServerSessionRecord {
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

    const record = this.sessions.get(sessionId);
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

    return { ...record };
  }

  /**
   * Updates the active wallet connection on an existing session (e.g., when linking an additional wallet).
   */
  public updateActiveWallet(
    sessionId: string,
    update: {
      activeWalletConnectionId: string;
      provider: WalletProviderType;
      identityKey: string;
    }
  ): ServerSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new AuthSessionError('SESSION_NOT_FOUND', 'Server session was not found.');
    }
    record.activeWalletConnectionId = update.activeWalletConnectionId;
    record.provider = update.provider;
    record.identityKey = update.identityKey;
    return { ...record };
  }

  /**
   * Revokes a session by token or session ID.
   */
  public revokeSession(tokenOrSessionId: string, now?: Date): void {
    const sessionId = tokenOrSessionId.includes('.')
      ? tokenOrSessionId.split('.')[0] ?? tokenOrSessionId
      : tokenOrSessionId;
    const record = this.sessions.get(sessionId);
    if (record && !record.revokedAt) {
      record.revokedAt = now ? new Date(now.getTime()) : new Date();
    }
  }

  /**
   * Revokes all active sessions associated with a specific walletConnectionId.
   */
  public revokeSessionsByWalletConnection(walletConnectionId: string, now?: Date): void {
    const revokedTime = now ? new Date(now.getTime()) : new Date();
    for (const record of this.sessions.values()) {
      if (record.activeWalletConnectionId === walletConnectionId && !record.revokedAt) {
        record.revokedAt = revokedTime;
      }
    }
  }

  public buildExpiredCookie(): CookieOptions {
    return {
      name: SESSION_COOKIE_NAME,
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 0,
      expires: new Date(0),
    };
  }

  public clear(): void {
    this.sessions.clear();
  }
}
