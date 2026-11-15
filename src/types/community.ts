export type CommunityStatusType =
  | 'PENDING_MINT'
  | 'ACTIVE'
  | 'PAYOUT_UNAVAILABLE'
  | 'ARCHIVED';

export type MintStatusType = 'PENDING' | 'MINTED' | 'VERIFIED' | 'FAILED';

export type ConfirmationStatusType = 'UNCONFIRMED' | 'CONFIRMED' | 'ORPHANED';

export interface CommunityNftMetadataV1 {
  /** Fixed application identifier for 1Sat Ordinals indexing */
  app: 'community-platform';
  /** Optional permanent content/artwork reference at genesis */
  artworkUrl: string | null;
  /** Permanent immutable platform community ID */
  communityId: string;
  /** Genesis community description snapshot */
  description: string;
  /** Genesis community name snapshot */
  name: string;
  /** Platform namespace identifier */
  platform: 'community-platform';
  /** Metadata schema version */
  schemaVersion: 1;
  /** 1Sat Ordinal type marker */
  type: 'ord';
}

export interface CommunityNftSummary {
  id: string;
  communityId: string;
  protocol: string;
  originTxid: string;
  originVout: number;
  /** Permanent genesis identifier: "<originTxid>_<originVout>" */
  origin: string;
  currentTxid: string;
  currentVout: number;
  /** Verified on-chain P2PKH locking script of current owner */
  currentOwnerScript: string;
  rawOutputScript: string | null;
  scriptType: string;
  isPayoutRoutable: boolean;
  lastVerifiedBlockHeight: number | null;
  lastVerifiedAt: Date | null;
  confirmationStatus: ConfirmationStatusType;
  mintStatus: MintStatusType;
  isMock: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CommunityRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  artworkUrl: string | null;
  status: CommunityStatusType;
  originalCreatorId: string;
  nftId: string | null;
  /** Authoritative verified on-chain locking script of the current NFT owner */
  currentOwnerScript: string | null;
  /** Optional platform wallet connection if the on-chain owner script matches a known WalletConnection */
  currentOwnerWalletConnectionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  nft?: CommunityNftSummary | null;
  revenuePolicy?: {
    version: number;
    ownerShareBps: number;
    platformShareBps: number;
  } | null;
}
