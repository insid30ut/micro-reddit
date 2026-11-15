import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getWalletAuthService } from '@/lib/auth/auth-service';
import {
  getSessionTokenFromRequest,
  resolveRequestDomain,
} from '@/lib/auth/http-helpers';

const ChallengeRequestSchema = z.object({
  provider: z.enum(['yours', 'handcash', 'mock']),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();
    const parsed = ChallengeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'provider must be one of: yours, handcash, mock',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const domain = resolveRequestDomain(request);
    const currentSessionToken = getSessionTokenFromRequest(request);
    const authService = getWalletAuthService();

    const challenge = await authService.issueChallenge({
      provider: parsed.data.provider,
      domain,
      currentSessionToken: currentSessionToken ?? null,
    });

    return NextResponse.json({
      challengeId: challenge.id,
      nonce: challenge.nonce,
      domain: challenge.domain,
      provider: challenge.provider,
      challengeText: challenge.challengeText,
      issuedAt: challenge.issuedAt.toISOString(),
      expiresAt: challenge.expiresAt.toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'CHALLENGE_GENERATION_FAILED',
        message: error instanceof Error ? error.message : 'Failed to issue challenge.',
      },
      { status: 500 }
    );
  }
}
