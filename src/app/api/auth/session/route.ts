import { NextResponse, type NextRequest } from 'next/server';
import {
  getWalletAuthService,
  WalletAuthError,
} from '@/lib/auth/auth-service';
import { getSessionTokenFromRequest } from '@/lib/auth/http-helpers';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = getSessionTokenFromRequest(request);
  const authService = getWalletAuthService();

  try {
    const context = await authService.getSessionContext(token);
    return NextResponse.json({
      authenticated: true,
      user: {
        id: context.user.id,
        displayName: context.user.displayName,
      },
      activeWallet: context.activeWallet
        ? {
            id: context.activeWallet.id,
            provider: context.activeWallet.provider,
            identityKey: context.activeWallet.identityKey,
            publicKey: context.activeWallet.publicKey,
            payoutScript: context.activeWallet.payoutScript,
            network: context.activeWallet.network,
            connected: context.activeWallet.connected,
            lastVerifiedAt: context.activeWallet.lastVerifiedAt.toISOString(),
          }
        : null,
      wallets: context.wallets.map((w) => ({
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
        sessionId: context.session.sessionId,
        issuedAt: context.session.issuedAt.toISOString(),
        expiresAt: context.session.expiresAt.toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof WalletAuthError) {
      return NextResponse.json(
        {
          authenticated: false,
          error: error.code,
          message: error.message,
        },
        { status: error.statusCode }
      );
    }
    return NextResponse.json(
      {
        authenticated: false,
        error: 'SESSION_CHECK_FAILED',
      },
      { status: 500 }
    );
  }
}
