import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type AuditEvent as PrismaAuditEvent,
  type PrismaClient,
  type User as PrismaUser,
  type WalletConnection as PrismaWalletConnection,
} from '@/generated/prisma/client';
import type {
  SignatureScheme,
  WalletDestinationProof,
  WalletProviderType,
} from '@/types/wallet';
import { prisma } from '@/lib/database/prisma';
import {
  AuthChallengeError,
  ChallengeStore,
  type AuthChallengeRecord,
} from '@/lib/auth/challenge-service';
import {
  isValidCompressedPublicKey,
  verifyDestinationOwnershipProof,
  verifyWalletChallengeSignature,
} from '@/lib/auth/crypto-verify';
import { isStandardP2PKHScript } from '@/lib/ordinals/script-parser';
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
  | 'NETWORK_MISMATCH'
  | 'INVALID_PUBLIC_KEY'
  | 'INVALID_PAYOUT_SCRIPT'
  | 'INVALID_DESTINATION_PROOF'
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
  payoutScript: string | null;
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
  /** Optional explicit P2PKH payout script reported by a wallet's derived payment key (requires destinationProof). */
  payoutScript?: string | null;
  /** Cryptographic ownership proof verifying wallet control of payoutScript. */
  destinationProof?: WalletDestinationProof | null;
  /** Client-reported network; must match the server's configured BSV_NETWORK when supplied. */
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

export interface WalletAuthServiceOptions {
  prisma?: PrismaClient;
  challengeStore?: ChallengeStore;
  sessionStore?: SessionStore;
  sessionSecret?: string;
  envSource?: Record<string, string | undefined>;
}

function mapUserRow(row: PrismaUser): UserAccountRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapWalletRow(row: PrismaWalletConnection): WalletConnectionRecord {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    identityKey: row.identityKey,
    publicKey: row.publicKey,
    payoutScript: row.currentPayoutScript ?? null,
    network: row.network === 'main' ? 'main' : 'test',
    connected: row.connected,
    lastVerifiedAt: row.lastAuthenticatedAt,
    createdAt: row.connectedAt,
    updatedAt: row.updatedAt,
  };
}

function mapAuditRow(row: PrismaAuditEvent): AuditEventRecord {
  return {
    id: row.id,
    eventType: row.eventType,
    actorUserId: row.actorUserId,
    targetType: row.entityType,
    targetId: row.entityId,
    payloadJson:
      typeof row.details === 'object' &&
      row.details !== null &&
      !Array.isArray(row.details)
        ? (row.details as Record<string, unknown>)
        : {},
    createdAt: row.createdAt,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002';
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code?: unknown }).code === 'P2002';
  }
  return false;
}

function mapChallengeError(error: AuthChallengeError): WalletAuthError {
  const codeMap: Record<string, WalletAuthErrorCode> = {
    CHALLENGE_NOT_FOUND: 'INVALID_CHALLENGE',
    CHALLENGE_EXPIRED: 'CHALLENGE_EXPIRED',
    CHALLENGE_REUSED: 'CHALLENGE_REUSED',
    DOMAIN_MISMATCH: 'DOMAIN_MISMATCH',
    PROVIDER_MISMATCH: 'PROVIDER_MISMATCH',
    SESSION_MISMATCH: 'INVALID_CHALLENGE',
  };
  return new WalletAuthError(
    codeMap[error.code] ?? 'INVALID_CHALLENGE',
    error.message,
    401
  );
}

/**
 * Coordinates authentication challenges, cryptographic verification,
 * PostgreSQL-backed account/wallet persistence, multi-wallet linking, and server sessions.
 */
export class WalletAuthService {
  private readonly prisma: PrismaClient;
  private readonly envSource: Record<string, string | undefined>;
  public readonly challengeStore: ChallengeStore;
  public readonly sessionStore: SessionStore;

  constructor(options?: WalletAuthServiceOptions) {
    this.prisma = options?.prisma ?? prisma;
    this.envSource = options?.envSource ?? process.env;
    this.challengeStore = options?.challengeStore ?? new ChallengeStore(this.prisma);
    this.sessionStore =
      options?.sessionStore ??
      new SessionStore({
        prisma: this.prisma,
        ...(options?.sessionSecret !== undefined
          ? { secret: options.sessionSecret }
          : {}),
        ...(options?.envSource ? { envSource: options.envSource } : {}),
      });
  }

  /**
   * Resolves the server's authoritative BSV network (`'main' | 'test'`).
   * Client-supplied network values are never trusted to override server configuration.
   */
  public getServerNetwork(): 'main' | 'test' {
    return this.envSource.BSV_NETWORK === 'test' ? 'test' : 'main';
  }

  private async recordAudit(
    eventType: string,
    actorUserId: string | null,
    targetType: string,
    targetId: string,
    payloadJson: Record<string, unknown>,
    now?: Date
  ): Promise<AuditEventRecord> {
    const created = await this.prisma.auditEvent.create({
      data: {
        id: randomUUID(),
        eventType,
        actorUserId,
        entityType: targetType,
        entityId: targetId,
        details: payloadJson as Prisma.InputJsonValue,
        ...(now ? { createdAt: new Date(now.getTime()) } : {}),
      },
    });
    return mapAuditRow(created);
  }

  /**
   * Issues a new single-use authentication challenge bound to the domain, provider,
   * and (if present) the caller's active session.
   */
  public async issueChallenge(params: {
    provider: WalletProviderType;
    domain: string;
    currentSessionToken?: string | null;
    ttlMs?: number;
    now?: Date;
  }): Promise<AuthChallengeRecord> {
    let sessionId: string | undefined;
    let userId: string | undefined;

    if (params.currentSessionToken) {
      try {
        const activeSession = await this.sessionStore.verifySessionToken(
          params.currentSessionToken,
          params.now
        );
        sessionId = activeSession.sessionId;
        userId = activeSession.userId;
      } catch {
        // Ignore expired/invalid session token when requesting a fresh login challenge
      }
    }

    const challenge = await this.challengeStore.issueChallenge({
      provider: params.provider,
      domain: params.domain,
      ...(sessionId ? { sessionId } : {}),
      ...(userId ? { userId } : {}),
      ...(params.ttlMs !== undefined ? { ttlMs: params.ttlMs } : {}),
      ...(params.now ? { now: params.now } : {}),
    });

    await this.recordAudit(
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
   * Verifies a signed authentication challenge, atomically consumes it to block replay,
   * prevents unauthorized cross-account wallet linking, and persists accounts/sessions in PostgreSQL.
   */
  public async verifyChallengeAndAuthenticate(
    input: VerifyAuthInput
  ): Promise<VerifyAuthResult> {
    const now = input.now ?? new Date();

    // Check if caller has an active session (for wallet linking)
    let activeSession: ServerSessionRecord | undefined;
    if (input.currentSessionToken) {
      try {
        activeSession = await this.sessionStore.verifySessionToken(
          input.currentSessionToken,
          now
        );
      } catch {
        activeSession = undefined;
      }
    }

    // 1. Validate the challenge record (existence, unused, non-expired, domain, provider)
    let challenge: AuthChallengeRecord;
    try {
      challenge = await this.challengeStore.validateChallenge({
        challengeId: input.challengeId,
        expectedDomain: input.expectedDomain,
        expectedProvider: input.provider,
        ...(activeSession ? { expectedSessionId: activeSession.sessionId } : {}),
        now,
      });
    } catch (error) {
      if (error instanceof AuthChallengeError) {
        await this.recordAudit(
          'AUTH_FAILED',
          activeSession?.userId ?? null,
          'AuthChallenge',
          input.challengeId,
          { reason: error.code, message: error.message },
          now
        );
        throw mapChallengeError(error);
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
      await this.recordAudit(
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

    // 2b. Enforce the server's configured BSV network; never trust a mismatched client network
    const serverNetwork = this.getServerNetwork();
    if (input.network !== undefined && input.network !== serverNetwork) {
      await this.recordAudit(
        'AUTH_FAILED',
        activeSession?.userId ?? null,
        'AuthChallenge',
        challenge.id,
        {
          reason: 'NETWORK_MISMATCH',
          clientNetwork: input.network,
          serverNetwork,
        },
        now
      );
      throw new WalletAuthError(
        'NETWORK_MISMATCH',
        `Wallet network "${input.network}" does not match server BSV_NETWORK "${serverNetwork}".`,
        400
      );
    }

    // 2c. Never silently derive a payout destination from `identityKey` on the server,
    // and never accept a client-supplied `payoutScript` without cryptographic ownership proof.
    let validatedPayoutScript: string | null = null;
    if (
      input.payoutScript !== undefined &&
      input.payoutScript !== null &&
      input.payoutScript.trim().length > 0
    ) {
      const normalizedScript = input.payoutScript.trim().toLowerCase();
      if (!isStandardP2PKHScript(normalizedScript)) {
        throw new WalletAuthError(
          'INVALID_PAYOUT_SCRIPT',
          'Explicit payoutScript must be a valid 25-byte standard P2PKH locking script.',
          400
        );
      }

      const proofResult = await verifyDestinationOwnershipProof({
        provider: input.provider,
        identityKey: normalizedIdentityKey,
        payoutScript: normalizedScript,
        destinationProof: input.destinationProof,
      });
      if (!proofResult.valid) {
        await this.recordAudit(
          'AUTH_FAILED',
          activeSession?.userId ?? null,
          'AuthChallenge',
          challenge.id,
          {
            reason: 'INVALID_DESTINATION_PROOF',
            message: proofResult.reason ?? 'Destination ownership proof verification failed.',
            provider: input.provider,
          },
          now
        );
        throw new WalletAuthError(
          'INVALID_DESTINATION_PROOF',
          proofResult.reason ??
            'Cryptographic destination ownership proof is required when supplying a payoutScript.',
          400
        );
      }

      validatedPayoutScript = normalizedScript;
    }

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
      await this.recordAudit(
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

    // 4. Atomically consume the single-use challenge before mutating account/session state
    try {
      await this.challengeStore.consumeChallenge(challenge.id, now);
    } catch (error) {
      if (error instanceof AuthChallengeError) {
        await this.recordAudit(
          'AUTH_FAILED',
          activeSession?.userId ?? null,
          'AuthChallenge',
          challenge.id,
          { reason: error.code, message: error.message },
          now
        );
        throw mapChallengeError(error);
      }
      throw error;
    }

    // 5. Resolve or persist account & wallet connection in PostgreSQL
    const existingConnection = await this.prisma.walletConnection.findUnique({
      where: {
        provider_identityKey: {
          provider: input.provider,
          identityKey: normalizedIdentityKey,
        },
      },
    });

    const targetUserId = activeSession?.userId ?? challenge.userId;
    let userRow: PrismaUser;
    let walletRow: PrismaWalletConnection;
    let linkedExistingAccount = false;

    if (targetUserId) {
      // Caller is authenticated and linking an additional wallet (or re-verifying an existing one)
      const currentUser = await this.prisma.user.findUnique({
        where: { id: targetUserId },
      });
      if (!currentUser) {
        throw new WalletAuthError(
          'UNAUTHORIZED',
          'Authenticated user record not found.',
          401
        );
      }

      // Security requirement: Prevent unauthorized wallet linking if this wallet belongs to another user
      if (existingConnection && existingConnection.userId !== currentUser.id) {
        await this.recordAudit(
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

      userRow = currentUser;
      linkedExistingAccount = true;

      if (existingConnection) {
        walletRow = await this.prisma.walletConnection.update({
          where: { id: existingConnection.id },
          data: {
            connected: true,
            publicKey: normalizedPubKey,
            currentPayoutScript:
              validatedPayoutScript ?? existingConnection.currentPayoutScript,
            network: serverNetwork,
            lastAuthenticatedAt: new Date(now.getTime()),
          },
        });
      } else {
        try {
          walletRow = await this.prisma.walletConnection.create({
            data: {
              id: randomUUID(),
              userId: currentUser.id,
              provider: input.provider,
              identityKey: normalizedIdentityKey,
              publicKey: normalizedPubKey,
              currentPayoutScript: validatedPayoutScript,
              network: serverNetwork,
              connected: true,
              connectedAt: new Date(now.getTime()),
              lastAuthenticatedAt: new Date(now.getTime()),
            },
          });
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw new WalletAuthError(
              'UNAUTHORIZED_WALLET_LINK',
              'This wallet is already linked to another account and cannot be claimed.',
              409
            );
          }
          throw error;
        }
      }

      await this.recordAudit(
        'WALLET_LINKED',
        userRow.id,
        'WalletConnection',
        walletRow.id,
        {
          provider: walletRow.provider,
          identityKey: walletRow.identityKey,
          signatureScheme: resolvedScheme,
        },
        now
      );
    } else if (existingConnection) {
      // Returning user logging in with an existing verified wallet
      const existingUser = await this.prisma.user.findUnique({
        where: { id: existingConnection.userId },
      });
      if (!existingUser) {
        throw new WalletAuthError('UNAUTHORIZED', 'User account not found.', 401);
      }
      userRow = existingUser;
      walletRow = await this.prisma.walletConnection.update({
        where: { id: existingConnection.id },
        data: {
          connected: true,
          publicKey: normalizedPubKey,
          currentPayoutScript:
            validatedPayoutScript ?? existingConnection.currentPayoutScript,
          network: serverNetwork,
          lastAuthenticatedAt: new Date(now.getTime()),
        },
      });
    } else {
      // New user + first wallet connection created atomically
      const displayName =
        input.displayName?.trim() ||
        `${input.provider}-${normalizedIdentityKey.slice(0, 8)}`;
      const username = `${input.provider}_${normalizedIdentityKey.slice(0, 12)}_${randomUUID().slice(0, 8)}`;

      try {
        const created = await this.prisma.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: {
              id: randomUUID(),
              username,
              displayName,
              createdAt: new Date(now.getTime()),
              updatedAt: new Date(now.getTime()),
            },
          });

          const newWallet = await tx.walletConnection.create({
            data: {
              id: randomUUID(),
              userId: newUser.id,
              provider: input.provider,
              identityKey: normalizedIdentityKey,
              publicKey: normalizedPubKey,
              currentPayoutScript: validatedPayoutScript,
              network: serverNetwork,
              connected: true,
              connectedAt: new Date(now.getTime()),
              lastAuthenticatedAt: new Date(now.getTime()),
            },
          });

          return { newUser, newWallet };
        });

        userRow = created.newUser;
        walletRow = created.newWallet;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new WalletAuthError(
            'UNAUTHORIZED_WALLET_LINK',
            'This wallet identity is already registered.',
            409
          );
        }
        throw error;
      }
    }

    const user = mapUserRow(userRow);
    const walletConnection = mapWalletRow(walletRow);

    // 6. Create persistent server session (and rotate prior session if replacing)
    const createdSession = await this.sessionStore.createSession({
      userId: user.id,
      activeWalletConnectionId: walletConnection.id,
      provider: walletConnection.provider,
      identityKey: walletConnection.identityKey,
      ...(input.sessionTtlMs !== undefined ? { ttlMs: input.sessionTtlMs } : {}),
      now,
    });

    if (activeSession) {
      await this.sessionStore.revokeSession(activeSession.sessionId, now);
    }

    await this.recordAudit(
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
      user,
      activeWallet: walletConnection,
      wallets: await this.listUserWallets(user.id),
      session: createdSession.session,
      sessionToken: createdSession.token,
      cookie: createdSession.cookie,
      linkedExistingAccount,
    };
  }

  /**
   * Resolves the authenticated session context from PostgreSQL using a session token.
   */
  public async getSessionContext(
    sessionToken: string | undefined | null,
    now?: Date
  ): Promise<SessionContextResult> {
    try {
      const session = await this.sessionStore.verifySessionToken(sessionToken, now);
      const userRow = await this.prisma.user.findUnique({
        where: { id: session.userId },
      });
      if (!userRow) {
        throw new WalletAuthError('UNAUTHORIZED', 'Authenticated user not found.', 401);
      }

      const wallets = await this.listUserWallets(userRow.id);
      const activeWallet = wallets.find(
        (w) => w.id === session.activeWalletConnectionId
      );

      return {
        session,
        user: mapUserRow(userRow),
        activeWallet,
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
  public async listUserWallets(userId: string): Promise<WalletConnectionRecord[]> {
    const rows = await this.prisma.walletConnection.findMany({
      where: { userId },
      orderBy: { connectedAt: 'asc' },
    });
    return rows.map(mapWalletRow);
  }

  /**
   * Disconnects a wallet belonging to the authenticated user.
   * If the disconnected wallet leaves no remaining connected wallets, revokes the current session in PostgreSQL.
   */
  public async disconnectWallet(params: {
    sessionToken: string | undefined | null;
    walletConnectionId?: string;
    now?: Date;
  }): Promise<{
    disconnectedWallet: WalletConnectionRecord;
    remainingConnectedWallets: WalletConnectionRecord[];
    sessionRevoked: boolean;
  }> {
    const now = params.now ?? new Date();
    const context = await this.getSessionContext(params.sessionToken, now);
    const targetWalletId =
      params.walletConnectionId ?? context.session.activeWalletConnectionId;

    const walletRow = await this.prisma.walletConnection.findUnique({
      where: { id: targetWalletId },
    });
    if (!walletRow || walletRow.userId !== context.user.id) {
      throw new WalletAuthError(
        'WALLET_NOT_FOUND',
        'Target wallet connection was not found for the authenticated user.',
        404
      );
    }

    const updatedWalletRow = await this.prisma.walletConnection.update({
      where: { id: walletRow.id },
      data: {
        connected: false,
      },
    });
    const disconnectedWallet = mapWalletRow(updatedWalletRow);

    const remainingConnectedWallets = (
      await this.listUserWallets(context.user.id)
    ).filter((w) => w.connected);

    let sessionRevoked = false;
    if (remainingConnectedWallets.length === 0) {
      await this.sessionStore.revokeSession(context.session.sessionId, now);
      sessionRevoked = true;
    } else if (context.session.activeWalletConnectionId === walletRow.id) {
      const fallback = remainingConnectedWallets[0]!;
      await this.sessionStore.updateActiveWallet(context.session.sessionId, {
        activeWalletConnectionId: fallback.id,
        provider: fallback.provider,
        identityKey: fallback.identityKey,
      });
    }

    await this.recordAudit(
      'WALLET_DISCONNECTED',
      context.user.id,
      'WalletConnection',
      disconnectedWallet.id,
      {
        provider: disconnectedWallet.provider,
        identityKey: disconnectedWallet.identityKey,
        sessionRevoked,
      },
      now
    );

    return {
      disconnectedWallet,
      remainingConnectedWallets,
      sessionRevoked,
    };
  }

  /**
   * Cryptographically verifies and persists an explicit derived destination P2PKH script
   * (`currentPayoutScript`) onto an authenticated user's wallet connection.
   */
  public async updateVerifiedWalletDestination(params: {
    sessionToken: string | undefined | null;
    provider?: WalletProviderType;
    destinationProof: WalletDestinationProof;
    now?: Date;
  }): Promise<WalletConnectionRecord> {
    const now = params.now ?? new Date();
    const context = await this.getSessionContext(params.sessionToken, now);

    const targetWallet =
      (params.provider
        ? context.wallets.find((w) => w.provider === params.provider && w.connected)
        : context.activeWallet) ??
      context.activeWallet;

    if (!targetWallet || targetWallet.userId !== context.user.id) {
      throw new WalletAuthError(
        'WALLET_NOT_FOUND',
        'No connected wallet matching the selected provider was found for this session.',
        404
      );
    }

    const proofCheck = await verifyDestinationOwnershipProof({
      provider: targetWallet.provider,
      identityKey: targetWallet.identityKey,
      payoutScript: params.destinationProof.lockingScript,
      destinationProof: params.destinationProof,
    });

    if (!proofCheck.valid || !proofCheck.derivedScript) {
      await this.recordAudit(
        'WALLET_DESTINATION_REJECTED',
        context.user.id,
        'WalletConnection',
        targetWallet.id,
        {
          provider: targetWallet.provider,
          reason: proofCheck.reason ?? 'Invalid destination ownership proof.',
        },
        now
      );
      throw new WalletAuthError(
        'INVALID_DESTINATION_PROOF',
        proofCheck.reason ?? 'Cryptographic destination ownership proof verification failed.',
        400
      );
    }

    const updated = await this.prisma.walletConnection.update({
      where: { id: targetWallet.id },
      data: {
        currentPayoutScript: proofCheck.derivedScript,
      },
    });

    await this.recordAudit(
      'WALLET_DESTINATION_VERIFIED',
      context.user.id,
      'WalletConnection',
      updated.id,
      {
        provider: updated.provider,
        payoutScript: proofCheck.derivedScript,
        destinationPublicKey: params.destinationProof.publicKey.trim().toLowerCase(),
        keyID: params.destinationProof.keyID ?? null,
        signatureScheme: params.destinationProof.signatureScheme,
      },
      now
    );

    return mapWalletRow(updated);
  }

  /**
   * Logs out and revokes the persistent server-side session in PostgreSQL.
   */
  public async logout(
    sessionToken: string | undefined | null,
    now?: Date
  ): Promise<CookieOptions> {
    if (sessionToken) {
      try {
        const session = await this.sessionStore.verifySessionToken(sessionToken, now);
        await this.sessionStore.revokeSession(session.sessionId, now);
        await this.recordAudit(
          'AUTH_LOGOUT',
          session.userId,
          'Session',
          session.sessionId,
          { provider: session.provider },
          now
        );
      } catch {
        // Ignore invalid/expired tokens during logout while always clearing cookie
      }
    }
    return this.sessionStore.buildExpiredCookie();
  }

  public async getAuditEvents(): Promise<AuditEventRecord[]> {
    const rows = await this.prisma.auditEvent.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(mapAuditRow);
  }

  public async clear(): Promise<void> {
    await this.sessionStore.clear();
    await this.challengeStore.clear();
    await this.prisma.auditEvent.deleteMany();
    await this.prisma.walletConnection.deleteMany();
    await this.prisma.user.deleteMany();
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
