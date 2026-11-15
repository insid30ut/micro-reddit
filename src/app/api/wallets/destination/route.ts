import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  getWalletAuthService,
  WalletAuthError,
} from '@/lib/auth/auth-service';
import {
  DestinationProofSchema,
  getSessionTokenFromRequest,
  normalizeDestinationProofInput,
} from '@/lib/auth/http-helpers';

const UpdateDestinationSchema = z.object({
  provider: z.enum(['yours', 'handcash', 'mock']).optional(),
  destinationProof: DestinationProofSchema,
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const sessionToken = getSessionTokenFromRequest(request);
    if (!sessionToken) {
      return NextResponse.json(
        {
          error: 'UNAUTHORIZED',
          message: 'An authenticated wallet session is required.',
        },
        { status: 401 }
      );
    }

    const body: unknown = await request.json();
    const parsed = UpdateDestinationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'Invalid destination ownership proof payload.',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const authService = getWalletAuthService();
    const updatedWallet = await authService.updateVerifiedWalletDestination({
      sessionToken,
      ...(parsed.data.provider ? { provider: parsed.data.provider } : {}),
      destinationProof: normalizeDestinationProofInput(
        parsed.data.destinationProof
      ),
    });

    return NextResponse.json({
      verified: true,
      currentPayoutScript: updatedWallet.payoutScript,
      wallet: {
        id: updatedWallet.id,
        provider: updatedWallet.provider,
        identityKey: updatedWallet.identityKey,
        publicKey: updatedWallet.publicKey,
        payoutScript: updatedWallet.payoutScript,
        network: updatedWallet.network,
        connected: updatedWallet.connected,
        lastVerifiedAt: updatedWallet.lastVerifiedAt.toISOString(),
      },
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
        error: 'DESTINATION_VERIFICATION_FAILED',
        message:
          error instanceof Error
            ? error.message
            : 'Failed to verify wallet destination.',
      },
      { status: 500 }
    );
  }
}
