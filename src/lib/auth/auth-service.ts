import { randomUUID } from 'node:crypto';
import type { SignatureScheme, WalletProviderType } from '@/types/wallet';
import {
  AuthChallengeError,
  ChallengeStore,
  type AuthChallengeRecord,
} from '@/lib/auth/challenge-service';
import {
  deriveP2PKHScriptFromPublicKey,
  isValidCompressedPublicKey,
  verifyWalletChallengeSignature,
} from '@/lib/auth/crypto-verify';
import {
  AuthSessionError,
  SessionStore,
  type CookieOptions,
  type ServerSessionRecord,
} from '@/lib/auth/session-service';

export type WalletAuthErrorCode =
  | 'INVALID_CHALLENGE'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_REUSED'
  | 'DOMAIN_MISMATCH'
  | 'PROVIDER_MISMATCH'
  | 'INVALID_PUBLIC_KEY'
  | 'INVALID_SIGNATURE'
  | 'UNAUTHORIZED_WALLET_LINK'
  | 'WALLET_NOT_FOUND'
  | 'UNAUTHORIZED';

export class WalletAuthError extends Error {
  public readonly code: WalletAuthErrorCode;
  public readonly statusCode: number;

  constructor(code: WalletAuthErrorCode, message: string, statusCode = 401) {
    super(message);
    this.name = 'WalletAuthError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface UserAccountRecord {
  id: string;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletConnectionRecord {
  id: string;
  userId: string;
  provider: WalletProviderType;
  identityKey: string;
  publicKey: string;
  payoutScript: string;
  network: 'main' | 'test';
  connected: boolean;
  lastVerifiedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditEventRecord {
  id: string;
  eventType: string;
  actorUserId: string | null;
  targetType: string;
  targetId: string;
  payloadJson: Record<string, unknown>;
  createdAt: Date;
}

export interface VerifyAuthInput {
  challengeId: string;
  provider: WalletProviderType;
  publicKey: string;
  identityKey?: string;
  signature: string;
  keyID?: string;
  signatureScheme?: SignatureScheme;
  expectedDomain: string;
  network?: 'main' | 'test';
  displayName?: string;
  currentSessionToken?: string | null;
  sessionTtlMs?: number;
  now?: Date;
}

export interface VerifyAuthResult {
  user: UserAccountRecord;
  activeWallet: WalletConnectionRecord;
  wallets: WalletConnectionRecord[];
  session: ServerSessionRecord;
  sessionToken: string;
  cookie: CookieOptions;
  linkedExistingAccount: boolean;
}

export interface SessionContextResult {
  session: ServerSessionRecord;
  user: UserAccountRecord;
  activeWallet: WalletConnectionRecord | undefined;
  wallets: WalletConnectionRecord[];
}

/**
 * Coordinates authentication challenges, cryptographic verification,
 * account/wallet persistence, multi-wallet linking, and server sessions.
 */
export class WalletAuthService {
  public readonly challengeStore: ChallengeStore;
  public readonly sessionStore: SessionStore;

  private readonly users = new Map<string, UserAccountRecord>();
  private readonly walletConnections = new Map<string, WalletConnectionRecord>();
  private readonly walletIndexByProviderKey = new Map<string, string>();
  private readonly auditEvents: AuditEventRecord[] = [];

  constructor(options?: {
    challengeStore?: ChallengeStore;
    sessionStore?: SessionStore;
    sessionSecret?: string;
  }) {
    this.challengeStore = options?.challengeStore ?? new ChallengeStore();
    this.sessionStore = options?.sessionStore ?? new SessionStore(options?.sessionSecret);
  }

  private getProviderIdentityIndexKey(provider: WalletProviderType, identityKey: string): string {
    return `${provider}:${identityKey.trim().toLowerCase()}`;
  }

  private recordAudit(
    eventType: string,
    actorUserId: string | null,
    targetType: string,
    targetId: string,
    payloadJson: Record<string, unknown>,
    now?: Date
  ): AuditEventRecord {
    const event: AuditEventRecord = {
      id: randomUUID(),
      eventType,
      actorUserId,
      targetType,
      targetId,
      payloadJson,
      createdAt: now ? new Date(now.getTime()) : new Date(),
    };
    this.auditEvents.push(event);
    return event;
  }

  /**
   * Issues a new single-use authentication challenge bound to the domain, provider,
   * and (if present) the caller's active session.
   */
  public issueChallenge(params: {
    provider: WalletProviderType;
    domain: string;
    currentSessionToken?: string | null;
    ttlMs?: number;
    now?: Date;
  }): AuthChallengeRecord {
    let sessionId: string | undefined;
    let userId: string | undefined;

    if (params.currentSessionToken) {
      try {
        const activeSession = this.sessionStore.verifySessionToken(
          params.currentSessionToken,
          params.now
        );
        sessionId = activeSession.sessionId;
        userId = activeSession.userId;
      } catch {
        // Ignore expired/invalid session token when requesting a fresh login challenge
      }
    }

    const challenge = this.challengeStore.issueChallenge({
      provider: params.provider,
      domain: params.domain,
      ...(sessionId ? { sessionId } : {}),
      ...(userId ? { userId } : {}),
      ...(params.ttlMs !== undefined ? { ttlMs: params.ttlMs } : {}),
      ...(params.now ? { now: params.now } : {}),
    });

    this.recordAudit(
      'AUTH_CHALLENGE_ISSUED',
      userId ?? null,
      'AuthChallenge',
      challenge.id,
      {
        provider: challenge.provider,
        domain: challenge.domain,
        expiresAt: challenge.expiresAt.toISOString(),
        boundToSession: Boolean(sessionId),
      },
      params.now
    );

    return challenge;
  }

  /**
   * Verifies a signed authentication challenge, enforces single-use and expiration rules,
   * prevents unauthorized cross-account wallet linking, and creates or updates a server session.
   */
  public async verifyChallengeAndAuthenticate(
    input: VerifyAuthInput
  ): Promise<VerifyAuthResult> {
    const now = input.now ?? new Date();

    // Check if caller has an active session (for wallet linking)
    let activeSession: ServerSessionRecord | undefined;
    if (input.currentSessionToken) {
      try {
        activeSession = this.sessionStore.verifySessionToken(input.currentSessionToken, now);
      } catch {
        activeSession = undefined;
      }
    }

    // 1. Validate the challenge record (existence, unused, non-expired, domain, provider)
    let challenge: AuthChallengeRecord;
    try {
      challenge = this.challengeStore.validateChallenge({
        challengeId: input.challengeId,
        expectedDomain: input.expectedDomain,
        expectedProvider: input.provider,
        ...(activeSession ? { expectedSessionId: activeSession.sessionId } : {}),
        now,
      });
    } catch (error) {
      if (error instanceof AuthChallengeError) {
        this.recordAudit(
          'AUTH_FAILED',
          activeSession?.userId ?? null,
          'AuthChallenge',
          input.challengeId,
          { reason: error.code, message: error.message },
          now
        );
        const codeMap: Record<string, WalletAuthErrorCode> = {
          CHALLENGE_NOT_FOUND: 'INVALID_CHALLENGE',
          CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
          CHALLENGE_REUSED: 'CHALLENGE_REUSED',
          DOMAIN_MISMATCH: 'DOMAIN_MISMATCH',
          PROVIDER_MISMATCH: 'PROVIDER_MISMATCH',
          SESSION_MISMATCH: 'INVALID_CHALLENGE',
        };
        throw new WalletAuthError(
          codeMap[error.code] ?? 'INVALID_CHALLENGE',
          error.message,
          401
        );
      }
      throw error;
    }

    // 2. Validate compressed secp256k1 publicKey & identityKey
    const normalizedPubKey = input.publicKey.trim().toLowerCase();
    const normalizedIdentityKey = (input.identityKey ?? input.publicKey)
      .trim()
      .toLowerCase();

    if (
      !isValidCompressedPublicKey(normalizedPubKey) ||
      !isValidCompressedPublicKey(normalizedIdentityKey)
    ) {
      this.recordAudit(
        'AUTH_FAILED',
        activeSession?.userId ?? null,
        'AuthChallenge',
        challenge.id,
        {
          reason: 'INVALID_PUBLIC_KEY',
          message: 'Invalid compressed secp256k1 public key.',
        },
        now
      );
      throw new WalletAuthError(
        'INVALID_PUBLIC_KEY',
        'Invalid compressed secp256k1 public key.',
        400
      );
    }

    if (normalizedPubKey !== normalizedIdentityKey) {
      throw new WalletAuthError(
        'INVALID_PUBLIC_KEY',
        'Signing publicKey must match the claimed wallet identityKey.',
        401
      );
    }

    const payoutScript = deriveP2PKHScriptFromPublicKey(normalizedIdentityKey);
    const resolvedScheme: SignatureScheme = input.signatureScheme ?? 'brc100';

    // 3. Cryptographically verify the signature against the exact server-stored challenge text
    const isValidSig = await verifyWalletChallengeSignature({
      challenge: challenge.challengeText,
      signature: input.signature,
      publicKey: normalizedIdentityKey,
      keyID: input.keyID ?? challenge.nonce,
      signatureScheme: resolvedScheme,
    });

    if (!isValidSig) {
      this.recordAudit(
        'AUTH_FAILED',
        activeSession?.userId ?? null,
        'AuthChallenge',
        challenge.id,
        {
          reason: 'INVALID_SIGNATURE',
          message: 'Cryptographic signature verification failed.',
          provider: input.provider,
          identityKey: normalizedIdentityKey,
        },
        now
      );
      throw new WalletAuthError(
        'INVALID_SIGNATURE',
        'Cryptographic signature verification failed.',
        401
      );
    }

    // 4. Consume the single-use challenge before mutating account state
    this.challengeStore.consumeChallenge(challenge.id, now);

    // 5. Resolve existing wallet connection (if any)
    const providerKey = this.getProviderIdentityIndexKey(input.provider, normalizedIdentityKey);
    const existingConnectionId = this.walletIndexByProviderKey.get(providerKey);
    const existingConnection = existingConnectionId
      ? this.walletConnections.get(existingConnectionId)
      : undefined;

    const targetUserId = activeSession?.userId ?? challenge.userId;
    let user: UserAccountRecord;
    let walletConnection: WalletConnectionRecord;
    let linkedExistingAccount = false;

    if (targetUserId) {
      // Caller is authenticated and linking an additional wallet (or re-verifying an existing one)
      const currentUser = this.users.get(targetUserId);
      if (!currentUser) {
        throw new WalletAuthError('UNAUTHORIZED', 'Authenticated user record not found.', 401);
      }

      // Security requirement: Prevent unauthorized wallet linking if this wallet belongs to another user
      if (existingConnection && existingConnection.userId !== currentUser.id) {
        this.recordAudit(
          'UNAUTHORIZED_WALLET_LINK_BLOCKED',
          currentUser.id,
          'WalletConnection',
          existingConnection.id,
          {
            provider: input.provider,
            identityKey: normalizedIdentityKey,
            ownerUserId: existingConnection.userId,
          },
          now
        );
        throw new WalletAuthError(
          'UNAUTHORIZED_WALLET_LINK',
          'This wallet is already linked to another account and cannot be claimed.',
          409
        );
      }

      user = currentUser;
      linkedExistingAccount = true;

      if (existingConnection) {
        existingConnection.connected = true;
        existingConnection.lastVerifiedAt = new Date(now.getTime());
        existingConnection.updatedAt = new Date(now.getTime());
        walletConnection = existingConnection;
      } else {
        walletConnection = {
          id: randomUUID(),
          userId: user.id,
          provider: input.provider,
          identityKey: normalizedIdentityKey,
          publicKey: normalizedPubKey,
          payoutScript,
          network: input.network ?? 'test',
          connected: true,
          lastVerifiedAt: new Date(now.getTime()),
          createdAt: new Date(now.getTime()),
          updatedAt: new Date(now.getTime()),
        };
        this.walletConnections.set(walletConnection.id, walletConnection);
        this.walletIndexByProviderKey.set(providerKey, walletConnection.id);
      }

      this.recordAudit(
        'WALLET_LINKED',
        user.id,
        'WalletConnection',
        walletConnection.id,
        {
          provider: walletConnection.provider,
          identityKey: walletConnection.identityKey,
          signatureScheme: resolvedScheme,
        },
        now
      );
    } else if (existingConnection) {
      // Returning user logging in with an existing verified wallet
      const existingUser = this.users.get(existingConnection.userId);
      if (!existingUser) {
        throw new WalletAuthError('UNAUTHORIZED', 'User account not found.', 401);
      }
      user = existingUser;
      existingConnection.connected = true;
      existingConnection.lastVerifiedAt = new Date(now.getTime());
      existingConnection.updatedAt = new Date(now.getTime());
      walletConnection = existingConnection;
    } else {
      // New user + first wallet connection
      user = {
        id: randomUUID(),
        displayName:
          input.displayName ??
          `${input.provider}-${normalizedIdentityKey.slice(0, 8)}`,
        createdAt: new Date(now.getTime()),
        updatedAt: new Date(now.getTime()),
      };
      this.users.set(user.id, user);

      walletConnection = {
        id: randomUUID(),
        userId: user.id,
        provider: input.provider,
        identityKey: normalizedIdentityKey,
        publicKey: normalizedPubKey,
        payoutScript,
        network: input.network ?? 'test',
        connected: true,
        lastVerifiedAt: new Date(now.getTime()),
        createdAt: new Date(now.getTime()),
        updatedAt: new Date(now.getTime()),
      };
      this.walletConnections.set(walletConnection.id, walletConnection);
      this.walletIndexByProviderKey.set(providerKey, walletConnection.id);
    }

    // 6. Create or update server session
    const createdSession = this.sessionStore.createSession({
      userId: user.id,
      activeWalletConnectionId: walletConnection.id,
      provider: walletConnection.provider,
      identityKey: walletConnection.identityKey,
      ...(input.sessionTtlMs !== undefined ? { ttlMs: input.sessionTtlMs } : {}),
      now,
    });

    if (activeSession) {
      // Revoke old session token after issuing replacement session with updated active wallet
      this.sessionStore.revokeSession(activeSession.sessionId, now);
    }

    this.recordAudit(
      'AUTH_VERIFIED',
      user.id,
      'WalletConnection',
      walletConnection.id,
      {
        provider: walletConnection.provider,
        identityKey: walletConnection.identityKey,
        signatureScheme: resolvedScheme,
        sessionId: createdSession.session.sessionId,
        linkedExistingAccount,
      },
      now
    );

    return {
      user: { ...user },
      activeWallet: { ...walletConnection },
      wallets: this.listUserWallets(user.id),
      session: createdSession.session,
      sessionToken: createdSession.token,
      cookie: createdSession.cookie,
      linkedExistingAccount,
    };
  }

  /**
   * Resolves the authenticated session context from a session token.
   */
  public getSessionContext(sessionToken: string | undefined | null, now?: Date): SessionContextResult {
    try {
      const session = this.sessionStore.verifySessionToken(sessionToken, now);
      const user = this.users.get(session.userId);
      if (!user) {
        throw new WalletAuthError('UNAUTHORIZED', 'Authenticated user not found.', 401);
      }
      const wallets = this.listUserWallets(user.id);
      const activeWallet = this.walletConnections.get(session.activeWalletConnectionId);

      return {
        session,
        user: { ...user },
        activeWallet: activeWallet ? { ...activeWallet } : undefined,
        wallets,
      };
    } catch (error) {
      if (error instanceof AuthSessionError) {
        throw new WalletAuthError('UNAUTHORIZED', error.message, 401);
      }
      throw error;
    }
  }

  /**
   * Lists all wallet connections associated with a user ID.
   */
  public listUserWallets(userId: string): WalletConnectionRecord[] {
    const results: WalletConnectionRecord[] = [];
    for (const record of this.walletConnections.values()) {
      if (record.userId === userId) {
        results.push({ ...record });
      }
    }
    return results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Disconnects a wallet belonging to the authenticated user.
   * If the disconnected wallet is the active wallet on the current session and no other
   * connected wallet remains, revokes the current session.
   */
  public disconnectWallet(params: {
    sessionToken: string | undefined | null;
    walletConnectionId?: string;
    now?: Date;
  }): {
    disconnectedWallet: WalletConnectionRecord;
    remainingConnectedWallets: WalletConnectionRecord[];
    sessionRevoked: boolean;
  } {
    const now = params.now ?? new Date();
    const context = this.getSessionContext(params.sessionToken, now);
    const targetWalletId =
      params.walletConnectionId ?? context.session.activeWalletConnectionId;

    const wallet = this.walletConnections.get(targetWalletId);
    if (!wallet || wallet.userId !== context.user.id) {
      throw new WalletAuthError(
        'WALLET_NOT_FOUND',
        'Target wallet connection was not found for the authenticated user.',
        404
      );
    }

    wallet.connected = false;
    wallet.updatedAt = new Date(now.getTime());

    const remainingConnectedWallets = this.listUserWallets(context.user.id).filter(
      (w) => w.connected
    );

    let sessionRevoked = false;
    if (remainingConnectedWallets.length === 0) {
      this.sessionStore.revokeSession(context.session.sessionId, now);
      sessionRevoked = true;
    } else if (context.session.activeWalletConnectionId === wallet.id) {
      const fallback = remainingConnectedWallets[0]!;
      this.sessionStore.updateActiveWallet(context.session.sessionId, {
        activeWalletConnectionId: fallback.id,
        provider: fallback.provider,
        identityKey: fallback.identityKey,
      });
    }

    this.recordAudit(
      'WALLET_DISCONNECTED',
      context.user.id,
      'WalletConnection',
      wallet.id,
      {
        provider: wallet.provider,
        identityKey: wallet.identityKey,
        sessionRevoked,
      },
      now
    );

    return {
      disconnectedWallet: { ...wallet },
      remainingConnectedWallets,
      sessionRevoked,
    };
  }

  /**
   * Logs out and revokes the server-side session.
   */
  public logout(sessionToken: string | undefined | null, now?: Date): CookieOptions {
    if (sessionToken) {
      try {
        const session = this.sessionStore.verifySessionToken(sessionToken, now);
        this.sessionStore.revokeSession(session.sessionId, now);
        this.recordAudit(
          'AUTH_LOGOUT',
          session.userId,
          'Session',
          session.sessionId,
          { provider: session.provider },
          now
        );
      } catch {
        this.sessionStore.revokeSession(sessionToken, now);
      }
    }
    return this.sessionStore.buildExpiredCookie();
  }

  public getAuditEvents(): AuditEventRecord[] {
    return this.auditEvents.map((e) => ({ ...e }));
  }

  public clear(): void {
    this.challengeStore.clear();
    this.sessionStore.clear();
    this.users.clear();
    this.walletConnections.clear();
    this.walletIndexByProviderKey.clear();
    this.auditEvents.length = 0;
  }
}

const globalForAuth = globalThis as unknown as {
  walletAuthServiceSingleton?: WalletAuthService;
};

export function getWalletAuthService(): WalletAuthService {
  if (!globalForAuth.walletAuthServiceSingleton) {
    globalForAuth.walletAuthServiceSingleton = new WalletAuthService();
  }
  return globalForAuth.walletAuthServiceSingleton;
}
