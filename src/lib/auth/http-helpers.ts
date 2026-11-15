import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, type CookieOptions } from '@/lib/auth/session-service';

/**
 * Resolves the request domain used for challenge domain binding.
 */
export function resolveRequestDomain(request: NextRequest): string {
  const hostHeader = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (hostHeader && hostHeader.trim().length > 0) {
    return hostHeader.trim().toLowerCase();
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  try {
    return new URL(appUrl).host.toLowerCase();
  } catch {
    return 'localhost:3000';
  }
}

/**
 * Reads the HttpOnly session cookie token from a NextRequest.
 */
export function getSessionTokenFromRequest(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * Attaches an HttpOnly session cookie to a NextResponse.
 */
export function applySessionCookie(response: NextResponse, cookie: CookieOptions): NextResponse {
  response.cookies.set({
    name: cookie.name,
    value: cookie.value,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    path: cookie.path,
    secure: cookie.secure,
    maxAge: cookie.maxAge,
    expires: cookie.expires,
  });
  return response;
}
