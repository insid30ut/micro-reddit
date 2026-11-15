import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { SESSION_COOKIE_NAME, type CookieOptions } from '@/lib/auth/session-service';
import type { WalletDestinationProof } from '@/types/wallet';

export const DestinationProofSchema = z.object({
  publicKey: z.string().min(66).max(66),
  lockingScript: z.string().min(50).max(50),
  address: z.string().optional(),
  signature: z.string().min(8),
  signatureScheme: z.enum(['brc100', 'ecdsa-sha256', 'bsm']),
  proofMessage: z.string().min(10),
  protocolID: z.tuple([z.union([z.literal(0), z.literal(1), z.literal(2)]), z.string()]).optional(),
  keyID: z.string().optional(),
  counterparty: z.string().optional(),
});

export function normalizeDestinationProofInput(
  parsed: z.infer<typeof DestinationProofSchema>
): WalletDestinationProof {
  return {
    publicKey: parsed.publicKey,
    lockingScript: parsed.lockingScript,
    signature: parsed.signature,
    signatureScheme: parsed.signatureScheme,
    proofMessage: parsed.proofMessage,
    ...(parsed.address !== undefined ? { address: parsed.address } : {}),
    ...(parsed.protocolID !== undefined ? { protocolID: parsed.protocolID } : {}),
    ...(parsed.keyID !== undefined ? { keyID: parsed.keyID } : {}),
    ...(parsed.counterparty !== undefined ? { counterparty: parsed.counterparty } : {}),
  };
}

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
