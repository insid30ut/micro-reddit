import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { WalletAuthError } from '@/lib/auth/auth-service';
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
 * Validates and normalizes an HTTP host authority (`hostname` or `hostname:port`).
 * Rejects multi-value comma lists, whitespace, credentials, paths, query strings,
 * control characters, and out-of-range ports.
 */
export function normalizeValidHostAuthority(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 255) {
    return null;
  }

  if (
    trimmed.includes(',') ||
    /[\s/\\?#@\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null;
  }

  const colonIdx = trimmed.lastIndexOf(':');
  const closeBracketIdx = trimmed.lastIndexOf(']');
  let hostPart = trimmed;

  if (colonIdx > closeBracketIdx) {
    hostPart = trimmed.slice(0, colonIdx);
    const portStr = trimmed.slice(colonIdx + 1);
    if (!/^\d{1,5}$/.test(portStr)) {
      return null;
    }
    const portNum = Number(portStr);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return null;
    }
  }

  if (hostPart.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(`http://${trimmed}`);
    if (
      parsed.hostname.toLowerCase() !== hostPart ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function extractHostnameFromAuthority(authority: string): string {
  if (authority.startsWith('[')) {
    const closeIdx = authority.indexOf(']');
    return closeIdx !== -1 ? authority.slice(0, closeIdx + 1) : authority;
  }
  const colonIdx = authority.lastIndexOf(':');
  return colonIdx !== -1 ? authority.slice(0, colonIdx) : authority;
}

const LOOPBACK_HOSTS = new Set<string>(['localhost', '127.0.0.1', '[::1]']);

function buildTrustedAuthDomainConfig(
  envSource: Record<string, string | undefined>
): {
  configuredAppHost: string;
  trustedHosts: Set<string>;
  allowLocalhostLoopback: boolean;
  trustProxyHeaders: boolean;
} {
  const trustedHosts = new Set<string>();
  const appUrlRaw = envSource.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  let configuredAppHost = 'localhost:3000';
  try {
    const parsedAppHost = new URL(appUrlRaw).host.toLowerCase();
    const validatedAppHost = normalizeValidHostAuthority(parsedAppHost);
    if (validatedAppHost) {
      configuredAppHost = validatedAppHost;
      trustedHosts.add(validatedAppHost);
    }
  } catch {
    trustedHosts.add('localhost:3000');
  }

  const extraDomains = envSource.ALLOWED_AUTH_DOMAINS ?? '';
  for (const entry of extraDomains.split(',')) {
    const cleaned = entry.trim();
    if (!cleaned) {
      continue;
    }
    const normalized = normalizeValidHostAuthority(cleaned);
    if (normalized) {
      trustedHosts.add(normalized);
    }
  }

  const allowLocalhostLoopback =
    envSource.NODE_ENV !== 'production' && envSource.APP_MODE !== 'live';
  const trustProxyHeaders = envSource.TRUST_PROXY_HEADERS === 'true';

  return {
    configuredAppHost,
    trustedHosts,
    allowLocalhostLoopback,
    trustProxyHeaders,
  };
}

function isTrustedAuthDomain(
  authority: string,
  trustedHosts: Set<string>,
  allowLocalhostLoopback: boolean
): boolean {
  if (trustedHosts.has(authority)) {
    return true;
  }
  if (allowLocalhostLoopback) {
    const hostname = extractHostnameFromAuthority(authority);
    if (LOOPBACK_HOSTS.has(hostname)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves and strictly validates the authentication request domain against the configured
 * application origin (`NEXT_PUBLIC_APP_URL`), optional `ALLOWED_AUTH_DOMAINS`, and
 * (outside production/live mode) local loopback hosts (`localhost`, `127.0.0.1`, `[::1]`).
 *
 * Never blindly trusts `x-forwarded-host` or `host` headers; throws `WalletAuthError` (400)
 * on spoofed, comma-separated, or malformed host headers.
 */
export function resolveRequestDomain(
  request: NextRequest,
  envSource: Record<string, string | undefined> = process.env
): string {
  const {
    configuredAppHost,
    trustedHosts,
    allowLocalhostLoopback,
    trustProxyHeaders,
  } = buildTrustedAuthDomainConfig(envSource);

  const forwardedHostHeader = request.headers.get('x-forwarded-host');
  const hostHeader = request.headers.get('host');

  if (forwardedHostHeader !== null) {
    const normalizedForwarded = normalizeValidHostAuthority(forwardedHostHeader);
    if (
      !normalizedForwarded ||
      !isTrustedAuthDomain(normalizedForwarded, trustedHosts, allowLocalhostLoopback)
    ) {
      throw new WalletAuthError(
        'DOMAIN_MISMATCH',
        'Untrusted or invalid x-forwarded-host header for authentication.',
        400
      );
    }
    if (trustProxyHeaders) {
      return normalizedForwarded;
    }
  }

  if (hostHeader !== null) {
    const normalizedHost = normalizeValidHostAuthority(hostHeader);
    if (
      !normalizedHost ||
      !isTrustedAuthDomain(normalizedHost, trustedHosts, allowLocalhostLoopback)
    ) {
      throw new WalletAuthError(
        'DOMAIN_MISMATCH',
        'Untrusted or invalid Host header for authentication.',
        400
      );
    }
    return normalizedHost;
  }

  return configuredAppHost;
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
