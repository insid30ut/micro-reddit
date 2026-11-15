import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getWalletAuthService, WalletAuthError } from '@/lib/auth/auth-service';
import { getSessionTokenFromRequest } from '@/lib/auth/http-helpers';
import { parseAppEnv } from '@/lib/config/env';
import {
  getMintVerificationService,
  MintVerificationError,
} from '@/lib/ordinals/mint-verification-service';

const ConfirmMintRequestSchema = z.object({
  /** Mode 'mock-mint' executes MockMintingAdapter (only allowed when APP_MODE="mock") and verifies the result. */
  action: z.enum(['mock-mint', 'verify-tx']).default('verify-tx'),
  /** Required when action === 'verify-tx' */
  txid: z.string().min(64).max(64).optional(),
  vout: z.number().int().min(0).optional(),
  expectedOrigin: z.string().optional(),
  /** Optional explicit destination P2PKH locking script for mock-mint */
  destinationP2PKHScript: z.string().optional(),
  /** Optional client-claimed network; rejected if it does not match server BSV_NETWORK */
  network: z.enum(['main', 'test']).optional(),
});

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

    const rawBody: unknown = await request.json().catch(() => ({}));
    const parsed = ConfirmMintRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'Invalid mint confirmation payload.',
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    const env = parseAppEnv();
    const mintService = getMintVerificationService();

    if (parsed.data.action === 'mock-mint') {
      if (env.APP_MODE !== 'mock') {
        return NextResponse.json(
          {
            error: 'MOCK_MINT_DISABLED_IN_LIVE_MODE',
            message:
              'Simulated mock minting is only available when APP_MODE="mock".',
          },
          { status: 403 }
        );
      }

      const outcome = await mintService.mintAndVerifyCommunityNft({
        communitySlugOrId: slug,
        authenticatedUserId: sessionContext.user.id,
        ...(parsed.data.destinationP2PKHScript
          ? { destinationP2PKHScript: parsed.data.destinationP2PKHScript }
          : {}),
        ...(parsed.data.network ? { claimedNetwork: parsed.data.network } : {}),
      });

      return NextResponse.json({
        verified: outcome.verified,
        activated: outcome.activated,
        community: outcome.community,
        nft: outcome.nft,
        metadata: {
          metadata: outcome.metadata.metadata,
          canonicalJson: outcome.metadata.canonicalJson,
          contentSha256Hex: outcome.metadata.contentSha256Hex,
        },
      });
    }

    if (!parsed.data.txid) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'txid is required when action is "verify-tx".',
        },
        { status: 400 }
      );
    }

    const outcome = await mintService.verifySubmittedMintTransaction({
      communitySlugOrId: slug,
      authenticatedUserId: sessionContext.user.id,
      txid: parsed.data.txid,
      vout: parsed.data.vout ?? 0,
      ...(parsed.data.expectedOrigin
        ? { expectedOrigin: parsed.data.expectedOrigin }
        : {}),
      ...(parsed.data.network ? { claimedNetwork: parsed.data.network } : {}),
    });

    return NextResponse.json({
      verified: outcome.verified,
      activated: outcome.activated,
      community: outcome.community,
      nft: outcome.nft,
      metadata: {
        metadata: outcome.metadata.metadata,
        canonicalJson: outcome.metadata.canonicalJson,
        contentSha256Hex: outcome.metadata.contentSha256Hex,
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
        error: 'MINT_CONFIRMATION_FAILED',
        message:
          error instanceof Error
            ? error.message
            : 'Failed to confirm community NFT mint.',
      },
      { status: 500 }
    );
  }
}
