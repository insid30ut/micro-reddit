import { NextResponse, type NextRequest } from 'next/server';
import { getWalletAuthService, WalletAuthError } from '@/lib/auth/auth-service';
import { getSessionTokenFromRequest } from '@/lib/auth/http-helpers';
import {
  CommunityServiceError,
  getCommunityService,
} from '@/lib/communities/community-service';

export async function GET(): Promise<NextResponse> {
  try {
    const communityService = getCommunityService();
    const communities = await communityService.listCommunities();
    return NextResponse.json({
      communities,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'COMMUNITIES_FETCH_FAILED',
        message:
          error instanceof Error ? error.message : 'Failed to list communities.',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const sessionToken = getSessionTokenFromRequest(request);
    if (!sessionToken) {
      return NextResponse.json(
        {
          error: 'UNAUTHENTICATED',
          message:
            'An authenticated wallet session is required to create a community.',
        },
        { status: 401 }
      );
    }

    const authService = getWalletAuthService();
    const sessionContext = await authService.getSessionContext(sessionToken);

    const body: unknown = await request.json();
    const communityService = getCommunityService();

    // `authenticatedUserId` is resolved strictly from the verified server session;
    // any client-supplied creator ID in the body is ignored by `CreateCommunitySchema`.
    const created = await communityService.createCommunity({
      authenticatedUserId: sessionContext.user.id,
      input: body,
    });

    return NextResponse.json(
      {
        community: created,
      },
      { status: 201 }
    );
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
    if (error instanceof CommunityServiceError) {
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
        error: 'COMMUNITY_CREATE_FAILED',
        message:
          error instanceof Error ? error.message : 'Failed to create community.',
      },
      { status: 500 }
    );
  }
}
