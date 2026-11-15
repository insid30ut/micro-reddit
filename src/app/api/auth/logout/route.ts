import { NextResponse, type NextRequest } from 'next/server';
import { getWalletAuthService } from '@/lib/auth/auth-service';
import {
  applySessionCookie,
  getSessionTokenFromRequest,
} from '@/lib/auth/http-helpers';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const token = getSessionTokenFromRequest(request);
  const authService = getWalletAuthService();
  const expiredCookie = authService.logout(token);

  const response = NextResponse.json({
    authenticated: false,
    message: 'Session revoked and logged out.',
  });

  return applySessionCookie(response, expiredCookie);
}
