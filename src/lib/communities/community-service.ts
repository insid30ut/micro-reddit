import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type Community as PrismaCommunity,
  type CommunityNFT as PrismaCommunityNFT,
  type PrismaClient,
  type RevenuePolicy as PrismaRevenuePolicy,
} from '@/generated/prisma/client';
import { z } from 'zod';
import { parseAppEnv } from '@/lib/config/env';
import {
  COMMUNITY_SLUG_REGEX,
  normalizeCommunitySlug,
} from '@/lib/communities/slug';
import { prisma } from '@/lib/database/prisma';
import type { CommunityNftSummary, CommunityRecord } from '@/types/community';

export { COMMUNITY_SLUG_REGEX, normalizeCommunitySlug };

export const CreateCommunitySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Community name must be at least 2 characters.')
    .max(120, 'Community name cannot exceed 120 characters.'),
  slug: z
    .string()
    .trim()
    .min(2, 'Community slug must be at least 2 characters.')
    .max(64, 'Community slug cannot exceed 64 characters.')
    .transform((val) => normalizeCommunitySlug(val))
    .refine(
      (val) => val.length >= 2 && COMMUNITY_SLUG_REGEX.test(val),
      'Slug must contain only lowercase letters, numbers, and single hyphens.'
    ),
  description: z
    .string()
    .trim()
    .min(10, 'Community description must be at least 10 characters.')
    .max(2000, 'Community description cannot exceed 2000 characters.'),
  artworkUrl: z
    .union([
      z.string().trim().url('Artwork URL must be a valid URL.').max(2048),
      z.literal(''),
      z.null(),
    ])
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val.trim() : null)),
});

export type CreateCommunityInput = z.input<typeof CreateCommunitySchema>;

export type CommunityErrorCode =
  | 'INVALID_COMMUNITY_INPUT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'DUPLICATE_SLUG'
  | 'COMMUNITY_NOT_FOUND';

export class CommunityServiceError extends Error {
  public readonly code: CommunityErrorCode;
  public readonly statusCode: number;

  constructor(code: CommunityErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = 'CommunityServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002';
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code?: unknown }).code === 'P2002';
  }
  return false;
}

export function mapCommunityNftRow(row: PrismaCommunityNFT): CommunityNftSummary {
  return {
    id: row.id,
    communityId: row.communityId,
    protocol: row.protocol,
    originTxid: row.originTxid,
    originVout: row.originVout,
    origin: row.origin,
    currentTxid: row.currentTxid,
    currentVout: row.currentVout,
    currentOwnerScript: row.currentOwnerScript,
    rawOutputScript: row.rawOutputScript,
    scriptType: row.scriptType,
    isPayoutRoutable: row.isPayoutRoutable,
    lastVerifiedBlockHeight: row.lastVerifiedBlockHeight,
    lastVerifiedAt: row.lastVerifiedAt,
    confirmationStatus: row.confirmationStatus,
    mintStatus: row.mintStatus,
    isMock: row.isMock,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapCommunityRow(
  row: PrismaCommunity & {
    nft?: PrismaCommunityNFT | null;
    revenuePolicies?: PrismaRevenuePolicy[];
  }
): CommunityRecord {
  const latestPolicy = row.revenuePolicies?.[0] ?? null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    artworkUrl: row.artworkUrl,
    status: row.status,
    originalCreatorId: row.originalCreatorId,
    nftId: row.nftId,
    currentOwnerScript: row.currentOwnerScript,
    currentOwnerWalletConnectionId: row.currentOwnerWalletConnectionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nft: row.nft ? mapCommunityNftRow(row.nft) : null,
    revenuePolicy: latestPolicy
      ? {
          version: latestPolicy.version,
          ownerShareBps: latestPolicy.ownerShareBps,
          platformShareBps: latestPolicy.platformShareBps,
        }
      : null,
  };
}

export interface CommunityServiceOptions {
  prisma?: PrismaClient;
  envSource?: Record<string, string | undefined>;
}

/**
 * CommunityService
 *
 * Manages community creation in initial `PENDING_MINT` state, slug uniqueness validation,
 * authenticated creator association, and community directory/detail queries.
 */
export class CommunityService {
  private readonly prisma: PrismaClient;
  private readonly envSource: Record<string, string | undefined>;

  constructor(options?: CommunityServiceOptions) {
    this.prisma = options?.prisma ?? prisma;
    this.envSource = options?.envSource ?? process.env;
  }

  /**
   * Creates a new community in `PENDING_MINT` status.
   *
   * Security rules:
   * - `authenticatedUserId` MUST come from the verified server session.
   * - `currentOwnerScript` starts as `null` until the minted 1Sat Ordinal NFT output
   *   is independently verified on-chain.
   */
  public async createCommunity(params: {
    authenticatedUserId: string | null | undefined;
    input: unknown;
    now?: Date;
  }): Promise<CommunityRecord> {
    if (!params.authenticatedUserId || params.authenticatedUserId.trim().length === 0) {
      throw new CommunityServiceError(
        'UNAUTHENTICATED',
        'An authenticated wallet session is required to create a community.',
        401
      );
    }

    const actorUserId = params.authenticatedUserId.trim();
    const userExists = await this.prisma.user.findUnique({
      where: { id: actorUserId },
    });
    if (!userExists) {
      throw new CommunityServiceError(
        'UNAUTHENTICATED',
        'Authenticated user account does not exist.',
        401
      );
    }

    const parsed = CreateCommunitySchema.safeParse(params.input);
    if (!parsed.success) {
      throw new CommunityServiceError(
        'INVALID_COMMUNITY_INPUT',
        parsed.error.issues.map((i) => i.message).join(' '),
        400
      );
    }

    const { name, slug, description, artworkUrl } = parsed.data;
    const now = params.now ?? new Date();
    const env = parseAppEnv(this.envSource);

    const existingSlug = await this.prisma.community.findUnique({
      where: { slug },
    });
    if (existingSlug) {
      throw new CommunityServiceError(
        'DUPLICATE_SLUG',
        `A community with slug "${slug}" already exists.`,
        409
      );
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const community = await tx.community.create({
          data: {
            id: randomUUID(),
            name,
            slug,
            description,
            artworkUrl,
            status: 'PENDING_MINT',
            originalCreatorId: actorUserId,
            nftId: null,
            currentOwnerScript: null,
            currentOwnerWalletConnectionId: null,
            createdAt: new Date(now.getTime()),
            updatedAt: new Date(now.getTime()),
          },
        });

        const policy = await tx.revenuePolicy.create({
          data: {
            id: randomUUID(),
            communityId: community.id,
            ownerShareBps: env.OWNER_SHARE_BPS,
            platformShareBps: env.PLATFORM_SHARE_BPS,
            version: 1,
            effectiveAt: new Date(now.getTime()),
            createdAt: new Date(now.getTime()),
          },
        });

        await tx.auditEvent.create({
          data: {
            id: randomUUID(),
            eventType: 'COMMUNITY_CREATED',
            actorUserId,
            entityType: 'Community',
            entityId: community.id,
            details: {
              slug: community.slug,
              name: community.name,
              status: community.status,
              ownerShareBps: policy.ownerShareBps,
              platformShareBps: policy.platformShareBps,
            } as Prisma.InputJsonValue,
            createdAt: new Date(now.getTime()),
          },
        });

        return {
          ...community,
          nft: null,
          revenuePolicies: [policy],
        };
      });

      return mapCommunityRow(created);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new CommunityServiceError(
          'DUPLICATE_SLUG',
          `A community with slug "${slug}" already exists.`,
          409
        );
      }
      throw error;
    }
  }

  /**
   * Lists all communities ordered newest first.
   */
  public async listCommunities(): Promise<CommunityRecord[]> {
    const rows = await this.prisma.community.findMany({
      include: {
        nft: true,
        revenuePolicies: {
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(mapCommunityRow);
  }

  /**
   * Retrieves a single community by slug or ID, including its NFT and revenue policy.
   */
  public async getCommunityBySlugOrId(identifier: string): Promise<CommunityRecord> {
    const trimmed = identifier.trim();
    const normalizedSlug = normalizeCommunitySlug(trimmed);

    const bySlug =
      normalizedSlug.length > 0
        ? await this.prisma.community.findUnique({
            where: { slug: normalizedSlug },
            include: {
              nft: true,
              revenuePolicies: {
                orderBy: { version: 'desc' },
                take: 1,
              },
            },
          })
        : null;

    if (bySlug) {
      return mapCommunityRow(bySlug);
    }

    const byId = await this.prisma.community.findUnique({
      where: { id: trimmed },
      include: {
        nft: true,
        revenuePolicies: {
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    });

    if (!byId) {
      throw new CommunityServiceError(
        'COMMUNITY_NOT_FOUND',
        `Community "${identifier}" was not found.`,
        404
      );
    }

    return mapCommunityRow(byId);
  }
}

let defaultCommunityService: CommunityService | null = null;

export function getCommunityService(): CommunityService {
  if (!defaultCommunityService) {
    defaultCommunityService = new CommunityService();
  }
  return defaultCommunityService;
}
