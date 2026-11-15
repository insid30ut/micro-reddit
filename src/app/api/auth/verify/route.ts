import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  getWalletAuthService,
  WalletAuthError,
} from '@/lib/auth/auth-service';
import {
  applySessionCookie,
  getSessionTokenFromRequest,
  resolveRequestDomain,
} from '@/lib/auth/http-helpers';

const VerifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  provider: z.enum(['yours', 'handcash', 'mock']),
  publicKey: z.string().min(66).max(66),
  identityKey: z.string().min(66).max(66).optional(),
  signature: z.string().min(8),
  keyID: z.string().min(1).optional(),
  signatureScheme: z.enum(['brc100', 'ecdsa-sha256', 'bsm']).optional(),
  network: z.enum(['main', 'test']).optional(),
  displayName: z.string().max(64).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();
    const parsed = VerifyRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'Invalid verification payload.',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const expectedDomain = resolveRequestDomain(request);
    const currentSessionToken = getSessionTokenFromRequest(request);
    const authService = getWalletAuthService();

    const result = await authService.verifyChallengeAndAuthenticate({
      challengeId: parsed.data.challengeId,
      provider: parsed.data.provider,
      publicKey: parsed.data.publicKey,
      ...(parsed.data.identityKey ? { identityKey: parsed.data.identityKey } : {}),
      signature: parsed.data.signature,
      ...(parsed.data.keyID ? { keyID: parsed.data.keyID } : {}),
      ...(parsed.data.signatureScheme
        ? { signatureScheme: parsed.data.signatureScheme }
        : {}),
      ...(parsed.data.network ? { network: parsed.data.network } : {}),
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
      expectedDomain,
      currentSessionToken: currentSessionToken ?? null,
    });

    const response = NextResponse.json({
      authenticated: true,
      linkedExistingAccount: result.linkedExistingAccount,
      user: {
        id: result.user.id,
        displayName: result.user.displayName,
      },
      activeWallet: {
        id: result.activeWallet.id,
        provider: result.activeWallet.provider,
        identityKey: result.activeWallet.identityKey,
        publicKey: result.activeWallet.publicKey,
        payoutScript: result.activeWallet.payoutScript,
        network: result.activeWallet.network,
        connected: result.activeWallet.connected,
        lastVerifiedAt: result.activeWallet.lastVerifiedAt.toISOString(),
      },
      wallets: result.wallets.map((w) => ({
        id: w.id,
        provider: w.provider,
        identityKey: w.identityKey,
        publicKey: w.publicKey,
        payoutScript: w.payoutScript,
        network: w.network,
        connected: w.connected,
        lastVerifiedAt: w.lastVerifiedAt.toISOString(),
      })),
      session: {
        sessionId: result.session.sessionId,
        issuedAt: result.session.issuedAt.toISOString(),
        expiresAt: result.session.expiresAt.toISOString(),
      },
    });

    return applySessionCookie(response, result.cookie);
  } catch (error) {
    if (error instanceof WalletAuthError) {
      return NextResponse.json(
        {
          error: error.code,
          message: error.message,
        },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      {
        error: 'AUTH_VERIFICATION_FAILED',
        message: error instanceof Error ? error.message : 'Verification failed.',
      },
      { status: 500 }
    );
  }
}
