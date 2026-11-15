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
    const metadataPreview = serializeCommunityNftMetadataDeterministically({
      communityId: community.id,
      name: community.name,
      description: community.description,
      artworkUrl: community.artworkUrl,
    });

    return NextResponse.json({
      community,
      nftMetadata: {
        metadata: metadataPreview.metadata,
        canonicalJson: metadataPreview.canonicalJson,
        contentSha256Hex: metadataPreview.contentSha256Hex,
        contentType: metadataPreview.contentType,
      },
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
        error: 'COMMUNITY_FETCH_FAILED',
        message:
          error instanceof Error ? error.message : 'Failed to fetch community.',
      },
      { status: 500 }
    );
  }
}
