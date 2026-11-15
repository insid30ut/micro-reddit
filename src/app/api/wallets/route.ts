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
      userId: context.user.id,
      activeWalletId: context.activeWallet?.id ?? null,
      wallets: context.wallets,
    });
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
        error: 'FETCH_WALLETS_FAILED',
        message: 'Failed to retrieve user wallets.',
      },
      { status: 500 }
    );
  }
}
