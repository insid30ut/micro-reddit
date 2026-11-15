import { NextResponse, type NextRequest } from 'next/server';
import { getWalletAuthService, WalletAuthError } from '@/lib/auth/auth-service';
import { getSessionTokenFromRequest } from '@/lib/auth/http-helpers';
import {
  getMintVerificationService,
  MintVerificationError,
} from '@/lib/ordinals/mint-verification-service';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  try {
    const sessionToken = getSessionTokenFromRequest(request);
    if (!sessionToken) {
      return NextResponse.json(
        {
          error: 'UNAUTHENTICATED',
          message: 'An authenticated wallet session is required.',
        },
        { status: 401 }
      );
    }

    const authService = getWalletAuthService();
    const sessionContext = await authService.getSessionContext(sessionToken);
    const { slug } = await context.params;

    const mintService = getMintVerificationService();
    const prepared = await mintService.prepareMintIntent({
      communitySlugOrId: slug,
      authenticatedUserId: sessionContext.user.id,
    });

    return NextResponse.json({
      community: prepared.community,
      serverNetwork: prepared.serverNetwork,
      mintIntent: {
        metadata: prepared.serializedMetadata.metadata,
        canonicalJson: prepared.serializedMetadata.canonicalJson,
        contentBase64: prepared.serializedMetadata.contentBase64,
        contentSha256Hex: prepared.serializedMetadata.contentSha256Hex,
        contentType: prepared.serializedMetadata.contentType,
        mapAttributes: prepared.serializedMetadata.mapAttributes,
      },
    });
  } catch (error) {
    if (error instanceof WalletAuthError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode }
      );
    }
    if (error instanceof MintVerificationError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode }
      );
    }
    return NextResponse.json(
      {
        error: 'MINT_INTENT_FAILED',
        message:
          error instanceof Error ? error.message : 'Failed to prepare mint intent.',
      },
      { status: 500 }
    );
  }
}
