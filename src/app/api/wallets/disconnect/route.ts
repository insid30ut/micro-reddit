import { NextResponse, type NextRequest } from 'next/server';
import {
  getWalletAuthService,
  WalletAuthError,
} from '@/lib/auth/auth-service';
import {
  applySessionCookie,
  getSessionTokenFromRequest,
} from '@/lib/auth/http-helpers';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const token = getSessionTokenFromRequest(request);
    const authService = getWalletAuthService();

    let walletConnectionId: string | undefined;
    try {
      const body: unknown = await request.json();
      if (
        body &&
        typeof body === 'object' &&
        'walletConnectionId' in body &&
        typeof (body as { walletConnectionId?: unknown }).walletConnectionId === 'string'
      ) {
        walletConnectionId = (body as { walletConnectionId: string }).walletConnectionId;
      }
    } catch {
      // Optional body
    }

    const result = await authService.disconnectWallet({
      sessionToken: token,
      ...(walletConnectionId ? { walletConnectionId } : {}),
    });

    const response = NextResponse.json({
      disconnected: true,
      disconnectedWallet: result.disconnectedWallet,
      remainingConnectedWallets: result.remainingConnectedWallets,
      sessionRevoked: result.sessionRevoked,
    });

    if (result.sessionRevoked) {
      return applySessionCookie(response, authService.sessionStore.buildExpiredCookie());
    }

    return response;
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
        error: 'WALLET_DISCONNECT_FAILED',
        message: error instanceof Error ? error.message : 'Failed to disconnect wallet.',
      },
      { status: 500 }
    );
  }
}
