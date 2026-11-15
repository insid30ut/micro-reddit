export type CommunityLifecycleStatus =
  | 'PENDING_MINT'
  | 'ACTIVE'
  | 'PAYOUT_UNAVAILABLE'
  | 'ARCHIVED';

export interface CommunitySummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  artworkUrl: string | null;
  status: CommunityLifecycleStatus;
  originalCreatorId: string;
  nftOrigin: string | null;
  /** Verified on-chain locking script of the current NFT owner */
  currentOwnerScript: string | null;
  /** Optional platform wallet connection ID when the on-chain owner has registered on the platform */
  currentOwnerWalletConnectionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
