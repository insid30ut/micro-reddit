import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import {
  MintingAdapterError,
  type MintTransactionLookupProvider,
  type OrdinalMintingAdapter,
} from '@/adapters/ordinals/minting-adapter';
import {
  getSharedMockChainTransactionStore,
  MockMintingAdapter,
} from '@/adapters/ordinals/mock-minting.adapter';
import { OneSatTransactionLookupProvider } from '@/adapters/ordinals/onesat-minting.adapter';
import {
  CommunityServiceError,
  mapCommunityNftRow,
  mapCommunityRow,
  normalizeCommunitySlug,
} from '@/lib/communities/community-service';
import { parseAppEnv } from '@/lib/config/env';
import { prisma } from '@/lib/database/prisma';
import {
  InvalidNftMetadataError,
  parseAndVerifyCommunityNftMetadata,
  serializeCommunityNftMetadataDeterministically,
  type SerializedCommunityNftMetadata,
} from '@/lib/ordinals/metadata';
import {
  extractOrdinalInscriptionEnvelope,
  isStandardP2PKHScript,
  parseOrdinalOutputScript,
} from '@/lib/ordinals/script-parser';
import type { CommunityNftSummary, CommunityRecord } from '@/types/community';

export type MintVerificationErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN_NOT_CREATOR'
  | 'COMMUNITY_NOT_FOUND'
  | 'DUPLICATE_MINT_REJECTED'
  | 'MINT_ALREADY_PENDING'
  | 'DUPLICATE_NFT_ORIGIN'
  | 'INVALID_DESTINATION_SCRIPT'
  | 'MINT_TX_NOT_FOUND'
  | 'MINT_WRONG_NETWORK'
  | 'MINT_MOCK_NOT_ALLOWED_IN_LIVE_MODE'
  | 'MINT_INVALID_OUTPUT'
  | 'MINT_INVALID_INSCRIPTION'
  | 'MINT_INVALID_METADATA'
  | 'MINT_ORIGIN_MISMATCH'
  | 'MINT_UNROUTABLE_LOCKING_SCRIPT';

function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2002';
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code?: unknown }).code === 'P2002';
  }
  return false;
}

export class MintVerificationError extends Error {
  public readonly code: MintVerificationErrorCode;
  public readonly statusCode: number;

  constructor(
    code: MintVerificationErrorCode,
    message: string,
    statusCode = 422
  ) {
    super(message);
    this.name = 'MintVerificationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface VerifyMintSubmissionInput {
  communitySlugOrId: string;
  authenticatedUserId: string | null | undefined;
  txid: string;
  vout?: number;
  expectedOrigin?: string;
  /** Optional client-claimed network; rejected if it conflicts with server BSV_NETWORK */
  claimedNetwork?: 'main' | 'test';
  now?: Date;
}

export interface MintAndVerifyInput {
  communitySlugOrId: string;
  authenticatedUserId: string | null | undefined;
  /** Explicit P2PKH locking script of the recipient wallet (or resolved from active wallet if present) */
  destinationP2PKHScript?: string;
  /** Optional client-claimed network; rejected if it conflicts with server BSV_NETWORK */
  claimedNetwork?: 'main' | 'test';
  simulatedConfirmations?: number;
  now?: Date;
}

export interface MintVerificationOutcome {
  verified: boolean;
  activated: boolean;
  community: CommunityRecord;
  nft: CommunityNftSummary;
  metadata: SerializedCommunityNftMetadata;
}

export interface MintVerificationServiceOptions {
  prisma?: PrismaClient;
  lookupProvider?: MintTransactionLookupProvider;
  mintingAdapter?: OrdinalMintingAdapter;
  envSource?: Record<string, string | undefined>;
}

/**
 * MintVerificationService
 *
 * Orchestrates 1Sat Ordinal mint intent preparation, modular minting execution,
 * and strict independent backend verification before transitioning a community
 * from `PENDING_MINT` to `ACTIVE`.
 */
export class MintVerificationService {
  private readonly prisma: PrismaClient;
  private readonly envSource: Record<string, string | undefined>;
  private readonly lookupProvider: MintTransactionLookupProvider;
  private readonly mintingAdapter: OrdinalMintingAdapter;

  constructor(options?: MintVerificationServiceOptions) {
    this.prisma = options?.prisma ?? prisma;
    this.envSource = options?.envSource ?? process.env;
    const env = parseAppEnv(this.envSource);

    this.lookupProvider =
      options?.lookupProvider ??
      (env.APP_MODE === 'live'
        ? new OneSatTransactionLookupProvider({
            apiBaseUrl: env.ONESAT_API_BASE_URL,
            network: env.BSV_NETWORK,
          })
        : getSharedMockChainTransactionStore());

    this.mintingAdapter = options?.mintingAdapter ?? new MockMintingAdapter();
  }

  public getServerNetwork(): 'main' | 'test' {
    return parseAppEnv(this.envSource).BSV_NETWORK;
  }

  /**
   * Each community receives exactly one NFT. Once a mint transaction has been recorded
   * (even if it is still awaiting confirmations), a new mint must not be started: the
   * caller should re-verify the existing transaction instead.
   */
  private assertNoPendingMint(
    nft: { origin: string; mintStatus: string } | null | undefined
  ): void {
    if (nft && nft.mintStatus !== 'FAILED') {
      throw new MintVerificationError(
        'MINT_ALREADY_PENDING',
        `This community already has a minted NFT (${nft.origin}) awaiting confirmation. Re-check that transaction instead of minting again.`,
        409
      );
    }
  }

  private async resolveCommunityRow(slugOrId: string) {
    const trimmed = slugOrId.trim();
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
      return bySlug;
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
      throw new MintVerificationError(
        'COMMUNITY_NOT_FOUND',
        `Community "${slugOrId}" was not found.`,
        404
      );
    }

    return byId;
  }

  /**
   * Generates the deterministic 1Sat Ordinals metadata payload for a pending community
   * so a client wallet or minting adapter can inscribe the exact canonical bytes.
   */
  public async prepareMintIntent(params: {
    communitySlugOrId: string;
    authenticatedUserId: string | null | undefined;
  }): Promise<{
    community: CommunityRecord;
    serializedMetadata: SerializedCommunityNftMetadata;
    serverNetwork: 'main' | 'test';
  }> {
    if (!params.authenticatedUserId) {
      throw new MintVerificationError(
        'UNAUTHENTICATED',
        'Authentication is required to prepare a community NFT mint.',
        401
      );
    }

    const communityRow = await this.resolveCommunityRow(params.communitySlugOrId);
    if (communityRow.originalCreatorId !== params.authenticatedUserId) {
      throw new MintVerificationError(
        'FORBIDDEN_NOT_CREATOR',
        'Only the original community creator can mint the genesis community NFT.',
        403
      );
    }

    if (
      communityRow.status === 'ACTIVE' ||
      communityRow.nft?.mintStatus === 'VERIFIED'
    ) {
      throw new MintVerificationError(
        'DUPLICATE_MINT_REJECTED',
        'This community already has a verified 1Sat Ordinal NFT.',
        409
      );
    }

    this.assertNoPendingMint(communityRow.nft);

    const serializedMetadata = serializeCommunityNftMetadataDeterministically({
      communityId: communityRow.id,
      name: communityRow.name,
      description: communityRow.description,
      artworkUrl: communityRow.artworkUrl,
    });

    return {
      community: mapCommunityRow(communityRow),
      serializedMetadata,
      serverNetwork: this.getServerNetwork(),
    };
  }

  /**
   * Executes a mint through the configured `OrdinalMintingAdapter` (e.g., `MockMintingAdapter`
   * in `APP_MODE=mock`) and immediately runs independent backend verification on the resulting
   * transaction.
   */
  public async mintAndVerifyCommunityNft(
    input: MintAndVerifyInput
  ): Promise<MintVerificationOutcome> {
    if (!input.authenticatedUserId) {
      throw new MintVerificationError(
        'UNAUTHENTICATED',
        'Authentication is required to mint a community NFT.',
        401
      );
    }

    const serverNetwork = this.getServerNetwork();
    if (
      input.claimedNetwork !== undefined &&
      input.claimedNetwork !== serverNetwork
    ) {
      throw new MintVerificationError(
        'MINT_WRONG_NETWORK',
        `Client network "${input.claimedNetwork}" does not match server BSV_NETWORK "${serverNetwork}".`,
        422
      );
    }

    const communityRow = await this.resolveCommunityRow(input.communitySlugOrId);
    if (communityRow.originalCreatorId !== input.authenticatedUserId) {
      throw new MintVerificationError(
        'FORBIDDEN_NOT_CREATOR',
        'Only the original community creator can mint the genesis community NFT.',
        403
      );
    }

    if (
      communityRow.status === 'ACTIVE' ||
      communityRow.nft?.mintStatus === 'VERIFIED'
    ) {
      throw new MintVerificationError(
        'DUPLICATE_MINT_REJECTED',
        'Duplicate mint rejected: this community already has a verified NFT.',
        409
      );
    }

    this.assertNoPendingMint(communityRow.nft);

    // Resolve destination P2PKH script from explicit parameter or from the creator's connected wallet
    let destinationScript = input.destinationP2PKHScript?.trim().toLowerCase();
    if (!destinationScript) {
      const creatorWallet = await this.prisma.walletConnection.findFirst({
        where: {
          userId: input.authenticatedUserId,
          connected: true,
          currentPayoutScript: { not: null },
        },
        orderBy: { lastAuthenticatedAt: 'desc' },
      });
      destinationScript = creatorWallet?.currentPayoutScript?.trim().toLowerCase();
    }

    if (!destinationScript || !isStandardP2PKHScript(destinationScript)) {
      throw new MintVerificationError(
        'INVALID_DESTINATION_SCRIPT',
        'A valid 25-byte standard P2PKH destination locking script is required to mint the community NFT.',
        400
      );
    }

    let mintResult;
    try {
      mintResult = await this.mintingAdapter.mintCommunityOrdinal({
        communityId: communityRow.id,
        name: communityRow.name,
        description: communityRow.description,
        artworkUrl: communityRow.artworkUrl,
        destinationP2PKHScript: destinationScript,
        network: serverNetwork,
        ...(input.simulatedConfirmations !== undefined
          ? { simulatedConfirmations: input.simulatedConfirmations }
          : {}),
      });
    } catch (error) {
      if (error instanceof MintingAdapterError) {
        throw new MintVerificationError(
          'INVALID_DESTINATION_SCRIPT',
          error.message,
          error.statusCode
        );
      }
      throw error;
    }

    return this.verifySubmittedMintTransaction({
      communitySlugOrId: communityRow.id,
      authenticatedUserId: input.authenticatedUserId,
      txid: mintResult.txid,
      vout: mintResult.vout,
      expectedOrigin: mintResult.origin,
      ...(input.now ? { now: input.now } : {}),
    });
  }

  /**
   * Independently verifies a minted 1Sat Ordinal transaction against the chain/indexer lookup
   * provider before activating a community.
   *
   * Never activates a community from client-supplied transaction info alone.
   */
  public async verifySubmittedMintTransaction(
    input: VerifyMintSubmissionInput
  ): Promise<MintVerificationOutcome> {
    if (!input.authenticatedUserId) {
      throw new MintVerificationError(
        'UNAUTHENTICATED',
        'Authentication is required to verify a community NFT mint.',
        401
      );
    }

    const now = input.now ?? new Date();
    const env = parseAppEnv(this.envSource);
    const serverNetwork = env.BSV_NETWORK;
    const communityRow = await this.resolveCommunityRow(input.communitySlugOrId);

    if (communityRow.originalCreatorId !== input.authenticatedUserId) {
      throw new MintVerificationError(
        'FORBIDDEN_NOT_CREATOR',
        'Only the original community creator can confirm the genesis community NFT.',
        403
      );
    }

    if (
      communityRow.status === 'ACTIVE' ||
      communityRow.nft?.mintStatus === 'VERIFIED'
    ) {
      throw new MintVerificationError(
        'DUPLICATE_MINT_REJECTED',
        'Duplicate mint confirmation rejected: this community already has a verified NFT.',
        409
      );
    }

    const recordVerificationFailure = async (
      reason: MintVerificationErrorCode,
      message: string,
      extraDetails: Record<string, unknown> = {}
    ): Promise<never> => {
      await this.prisma.auditEvent.create({
        data: {
          id: randomUUID(),
          eventType: 'COMMUNITY_NFT_MINT_VERIFICATION_FAILED',
          actorUserId: input.authenticatedUserId ?? null,
          entityType: 'Community',
          entityId: communityRow.id,
          details: {
            reason,
            message,
            txid: input.txid,
            vout: input.vout ?? 0,
            ...extraDetails,
          } as Prisma.InputJsonValue,
          createdAt: new Date(now.getTime()),
        },
      });
      throw new MintVerificationError(
        reason,
        message,
        reason === 'DUPLICATE_NFT_ORIGIN' || reason === 'MINT_ALREADY_PENDING'
          ? 409
          : 422
      );
    };

    if (
      input.claimedNetwork !== undefined &&
      input.claimedNetwork !== serverNetwork
    ) {
      return recordVerificationFailure(
        'MINT_WRONG_NETWORK',
        `Client-supplied network "${input.claimedNetwork}" does not match server BSV_NETWORK "${serverNetwork}".`,
        { claimedNetwork: input.claimedNetwork, serverNetwork }
      );
    }

    const normalizedTxid = input.txid.trim().toLowerCase();
    const vout = input.vout ?? 0;
    if (!/^[0-9a-f]{64}$/.test(normalizedTxid) || !Number.isInteger(vout) || vout < 0) {
      return recordVerificationFailure(
        'MINT_TX_NOT_FOUND',
        `Invalid transaction ID ("${input.txid}") or output index (${vout}).`
      );
    }

    const computedOrigin = `${normalizedTxid}_${vout}`;
    if (
      input.expectedOrigin !== undefined &&
      input.expectedOrigin.trim().toLowerCase() !== computedOrigin
    ) {
      return recordVerificationFailure(
        'MINT_ORIGIN_MISMATCH',
        `Expected origin "${input.expectedOrigin}" does not match computed origin "${computedOrigin}".`
      );
    }

    // 1. Check that no other community NFT claims this permanent origin
    const existingByOrigin = await this.prisma.communityNFT.findUnique({
      where: { origin: computedOrigin },
    });
    if (existingByOrigin && existingByOrigin.communityId !== communityRow.id) {
      return recordVerificationFailure(
        'DUPLICATE_NFT_ORIGIN',
        `Ordinal origin "${computedOrigin}" is already registered to another community.`
      );
    }

    // 1b. One NFT per community: while a recorded mint awaits confirmation, only that
    // same origin may be re-verified. A different txid/vout would replace the NFT identity.
    if (
      communityRow.nft &&
      communityRow.nft.mintStatus !== 'FAILED' &&
      communityRow.nft.origin !== computedOrigin
    ) {
      return recordVerificationFailure(
        'MINT_ALREADY_PENDING',
        `This community already has a minted NFT (${communityRow.nft.origin}) awaiting confirmation; a different mint (${computedOrigin}) cannot replace it.`,
        { pendingOrigin: communityRow.nft.origin }
      );
    }

    // 2. Independently retrieve the transaction from the chain/indexer provider
    const observedTx = await this.lookupProvider.getTransaction(
      normalizedTxid,
      serverNetwork
    );
    if (!observedTx) {
      return recordVerificationFailure(
        'MINT_TX_NOT_FOUND',
        `Transaction "${normalizedTxid}" could not be found on BSV network "${serverNetwork}".`
      );
    }

    // 3. Verify transaction network matches the server's configured BSV_NETWORK
    if (observedTx.network !== serverNetwork) {
      return recordVerificationFailure(
        'MINT_WRONG_NETWORK',
        `Transaction "${normalizedTxid}" belongs to network "${observedTx.network}", but server requires "${serverNetwork}".`,
        { txNetwork: observedTx.network, serverNetwork }
      );
    }

    // 4. Reject mock transactions when running in live mode
    if (env.APP_MODE === 'live' && observedTx.isMock) {
      return recordVerificationFailure(
        'MINT_MOCK_NOT_ALLOWED_IN_LIVE_MODE',
        'Simulated mock transactions are rejected when APP_MODE="live".'
      );
    }

    // 5. Verify target output exists and carries 1 satoshi
    const targetOutput = observedTx.outputs.find((o) => o.vout === vout);
    if (!targetOutput) {
      return recordVerificationFailure(
        'MINT_INVALID_OUTPUT',
        `Output index ${vout} does not exist in transaction "${normalizedTxid}".`
      );
    }
    if (targetOutput.satoshis !== 1) {
      return recordVerificationFailure(
        'MINT_INVALID_OUTPUT',
        `Ordinal output ${computedOrigin} must carry exactly 1 satoshi, found ${targetOutput.satoshis} satoshis.`
      );
    }

    // 6. Parse the raw output script to verify the 1Sat Ordinal envelope and extract the spending script
    const parsedScript = parseOrdinalOutputScript(targetOutput.lockingScriptHex);
    const extractedEnvelope = extractOrdinalInscriptionEnvelope(
      targetOutput.lockingScriptHex
    );
    if (
      !parsedScript.hasOrdEnvelope ||
      !extractedEnvelope.hasOrdEnvelope ||
      extractedEnvelope.contentType !== 'application/json' ||
      !extractedEnvelope.contentUtf8
    ) {
      return recordVerificationFailure(
        'MINT_INVALID_INSCRIPTION',
        `Output ${computedOrigin} does not contain a valid 1Sat Ordinal "ord" application/json inscription envelope.`
      );
    }

    // 7. Verify inscribed community metadata matches expected schema and community identity
    const expectedMetadata = serializeCommunityNftMetadataDeterministically({
      communityId: communityRow.id,
      name: communityRow.name,
      description: communityRow.description,
      artworkUrl: communityRow.artworkUrl,
    });

    let verifiedMetadata;
    try {
      verifiedMetadata = parseAndVerifyCommunityNftMetadata(
        extractedEnvelope.contentUtf8,
        communityRow.id
      );
    } catch (error) {
      const msg =
        error instanceof InvalidNftMetadataError
          ? error.message
          : 'Inscription metadata verification failed.';
      return recordVerificationFailure('MINT_INVALID_METADATA', msg);
    }

    if (
      verifiedMetadata.name !== expectedMetadata.metadata.name ||
      verifiedMetadata.description !== expectedMetadata.metadata.description ||
      verifiedMetadata.artworkUrl !== expectedMetadata.metadata.artworkUrl
    ) {
      return recordVerificationFailure(
        'MINT_INVALID_METADATA',
        'Inscription metadata fields (name, description, or artworkUrl) do not match the community record.'
      );
    }

    // 8. Verify underlying spending script is a standard routable P2PKH locking script
    if (
      parsedScript.scriptType !== 'P2PKH' ||
      !parsedScript.isPayoutRoutable ||
      !isStandardP2PKHScript(parsedScript.spendingScriptHex)
    ) {
      return recordVerificationFailure(
        'MINT_UNROUTABLE_LOCKING_SCRIPT',
        `Extracted spending script for ${computedOrigin} is classified as "${parsedScript.scriptType}" and is not a standard routable P2PKH locking script.`
      );
    }

    const authoritativeOwnerScript = parsedScript.spendingScriptHex;

    // 9. Check confirmation threshold (`OWNERSHIP_CONFIRMATIONS_REQUIRED`, minimum 1)
    const isConfirmed =
      observedTx.confirmations >= env.OWNERSHIP_CONFIRMATIONS_REQUIRED;
    const confirmationStatus = isConfirmed ? 'CONFIRMED' : 'UNCONFIRMED';
    const mintStatus = isConfirmed ? 'VERIFIED' : 'MINTED';

    // Persist verified NFT, initial ownership event, and community activation atomically
    let outcome;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // Optional platform wallet association if a registered WalletConnection has this exact payout script
        const matchedWallet = await tx.walletConnection.findFirst({
          where: {
            currentPayoutScript: authoritativeOwnerScript,
          },
          orderBy: { lastAuthenticatedAt: 'desc' },
        });

        const nftRow = communityRow.nft
          ? await tx.communityNFT.update({
              where: { id: communityRow.nft.id },
              data: {
                originTxid: normalizedTxid,
                originVout: vout,
                origin: computedOrigin,
                currentTxid: normalizedTxid,
                currentVout: vout,
                currentOwnerScript: authoritativeOwnerScript,
                rawOutputScript: parsedScript.rawScriptHex,
                scriptType: parsedScript.scriptType,
                isPayoutRoutable: parsedScript.isPayoutRoutable,
                lastVerifiedBlockHeight: observedTx.blockHeight,
                lastVerifiedAt: new Date(now.getTime()),
                confirmationStatus,
                mintStatus,
                isMock: observedTx.isMock,
                updatedAt: new Date(now.getTime()),
              },
            })
          : await tx.communityNFT.create({
              data: {
                id: randomUUID(),
                communityId: communityRow.id,
                protocol: '1sat',
                originTxid: normalizedTxid,
                originVout: vout,
                origin: computedOrigin,
                currentTxid: normalizedTxid,
                currentVout: vout,
                currentOwnerScript: authoritativeOwnerScript,
                rawOutputScript: parsedScript.rawScriptHex,
                scriptType: parsedScript.scriptType,
                isPayoutRoutable: parsedScript.isPayoutRoutable,
                lastVerifiedBlockHeight: observedTx.blockHeight,
                lastVerifiedAt: new Date(now.getTime()),
                confirmationStatus,
                mintStatus,
                isMock: observedTx.isMock,
                createdAt: new Date(now.getTime()),
                updatedAt: new Date(now.getTime()),
              },
            });

        const updatedCommunity = await tx.community.update({
          where: { id: communityRow.id },
          data: {
            nftId: nftRow.id,
            // Only transition to ACTIVE and set authoritative owner script once confirmation threshold is met
            ...(isConfirmed
              ? {
                  status: 'ACTIVE',
                  currentOwnerScript: authoritativeOwnerScript,
                  currentOwnerWalletConnectionId: matchedWallet?.id ?? null,
                }
              : {}),
            updatedAt: new Date(now.getTime()),
          },
          include: {
            nft: true,
            revenuePolicies: {
              orderBy: { version: 'desc' },
              take: 1,
            },
          },
        });

        // Re-verifying the same mint (e.g. polling for confirmations) updates the single
        // genesis ownership event instead of appending duplicate "first owner" entries.
        const existingGenesisEvent = await tx.ownershipEvent.findFirst({
          where: {
            nftId: nftRow.id,
            previousOutpoint: null,
            newOutpoint: computedOrigin,
          },
        });
        if (existingGenesisEvent) {
          await tx.ownershipEvent.update({
            where: { id: existingGenesisEvent.id },
            data: {
              blockHeight: observedTx.blockHeight,
              confirmationStatus,
            },
          });
        } else {
          await tx.ownershipEvent.create({
            data: {
              id: randomUUID(),
              communityId: communityRow.id,
              nftId: nftRow.id,
              previousOwnerScript: null,
              newOwnerScript: authoritativeOwnerScript,
              previousOutpoint: null,
              newOutpoint: computedOrigin,
              transactionId: normalizedTxid,
              blockHeight: observedTx.blockHeight,
              confirmationStatus,
              createdAt: new Date(now.getTime()),
            },
          });
        }

        await tx.auditEvent.create({
          data: {
            id: randomUUID(),
            eventType: isConfirmed
              ? 'COMMUNITY_NFT_MINT_VERIFIED'
              : 'COMMUNITY_NFT_MINT_OBSERVED_UNCONFIRMED',
            actorUserId: input.authenticatedUserId ?? null,
            entityType: 'CommunityNFT',
            entityId: nftRow.id,
            details: {
              communityId: communityRow.id,
              origin: computedOrigin,
              currentOwnerScript: authoritativeOwnerScript,
              scriptType: parsedScript.scriptType,
              isPayoutRoutable: parsedScript.isPayoutRoutable,
              confirmations: observedTx.confirmations,
              confirmationStatus,
              mintStatus,
              activated: isConfirmed,
              isMock: observedTx.isMock,
            } as Prisma.InputJsonValue,
            createdAt: new Date(now.getTime()),
          },
        });

        return { updatedCommunity, nftRow };
      });
    } catch (error) {
      // Two concurrent confirmations for the same community race on the unique
      // CommunityNFT.communityId / origin constraints; fail cleanly instead of a 500.
      if (isUniqueConstraintError(error)) {
        throw new MintVerificationError(
          'DUPLICATE_MINT_REJECTED',
          'Another mint confirmation for this community was recorded concurrently. Reload and re-check the existing NFT.',
          409
        );
      }
      throw error;
    }

    return {
      verified: isConfirmed,
      activated: isConfirmed,
      community: mapCommunityRow(outcome.updatedCommunity),
      nft: mapCommunityNftRow(outcome.nftRow),
      metadata: expectedMetadata,
    };
  }
}

let defaultMintVerificationService: MintVerificationService | null = null;

export function getMintVerificationService(): MintVerificationService {
  if (!defaultMintVerificationService) {
    defaultMintVerificationService = new MintVerificationService();
  }
  return defaultMintVerificationService;
}

export { CommunityServiceError };
