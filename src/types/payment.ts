export type PaymentLifecycleStatus =
  | 'CREATED'
  | 'AWAITING_WALLET'
  | 'SUBMITTED'
  | 'OBSERVED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'EXPIRED';

export type PaidActivityLifecycleStatus =
  | 'PENDING_CONFIRMATION'
  | 'AUTHORIZED'
  | 'REVOKED';

export interface RevenueAllocationResult {
  totalSatoshis: number;
  ownerSatoshis: number;
  platformSatoshis: number;
  ownerShareBps: number;
  platformShareBps: number;
}

export interface PaymentIntentSnapshotInput {
  userId: string;
  communityId: string;
  actionType: string;
  totalSatoshis: number;
  ownerShareBps: number;
  platformShareBps: number;
  ownerPayoutScript: string;
  platformPayoutScript: string;
  nftOrigin: string;
  ownerOutpointSnapshot: string;
  policyVersion: number;
  now?: Date;
  expirySeconds?: number;
}

export interface PaymentSettlementEvaluation {
  paymentStatus: 'OBSERVED' | 'CONFIRMED' | 'FAILED';
  canAuthorizePaidActivity: boolean;
  activityStatus: PaidActivityLifecycleStatus | null;
  confirmations: number;
  requiredConfirmations: number;
  reason: string;
}
