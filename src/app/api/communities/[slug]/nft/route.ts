import { NextResponse, type NextRequest } from 'next/server';
import {
  CommunityServiceError,
  getCommunityService,
} from '@/lib/communities/community-service';
import { serializeCommunityNftMetadataDeterministically } from '@/lib/ordinals/metadata';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const communityService = getCommunityService();
    const community = await communityService.getCommunityBySlugOrId(slug);
    const serialized = serializeCommunityNftMetadataDeterministically({
      communityId: community.id,
      name: community.name,
      description: community.description,
      artworkUrl: community.artworkUrl,
    });

    return NextResponse.json({
      communityId: community.id,
      communityStatus: community.status,
      nft: community.nft ?? null,
      metadata: serialized.metadata,
      canonicalJson: serialized.canonicalJson,
      contentSha256Hex: serialized.contentSha256Hex,
      contentType: serialized.contentType,
    });
  } catch (error) {
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
        error: 'COMMUNITY_NFT_FETCH_FAILED',
        message:
          error instanceof Error ? error.message : 'Failed to fetch community NFT.',
      },
      { status: 500 }
    );
  }
}
