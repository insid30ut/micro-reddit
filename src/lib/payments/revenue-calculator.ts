import { isStandardP2PKHScript } from '@/lib/ordinals/script-parser';
import type {
  PaymentIntentSnapshotInput,
  PaymentSettlementEvaluation,
  RevenueAllocationResult,
} from '@/types/payment';

export const TOTAL_BASIS_POINTS = 10_000;
export const MIN_OWNER_SHARE_BPS = 5_000;
export const DEFAULT_OWNER_SHARE_BPS = 7_000;
export const DEFAULT_PLATFORM_SHARE_BPS = 3_000;

/**
 * Validates that a revenue policy satisfies PoC constraints:
 * - Integer basis points
 * - ownerShareBps >= 5000 (minimum 50% to community NFT holder)
 * - ownerShareBps + platformShareBps === 10000
 */
export function validateRevenuePolicyBps(
  ownerShareBps: number,
  platformShareBps: number
): void {
  if (!Number.isInteger(ownerShareBps) || !Number.isInteger(platformShareBps)) {
    throw new Error('Revenue share basis points must be integers.');
  }
  if (ownerShareBps < MIN_OWNER_SHARE_BPS) {
    throw new Error(
      `Owner share (${ownerShareBps} bps) must be at least ${MIN_OWNER_SHARE_BPS} bps (50%).`
    );
  }
  if (platformShareBps < 0) {
    throw new Error('Platform share basis points cannot be negative.');
  }
  if (ownerShareBps + platformShareBps !== TOTAL_BASIS_POINTS) {
    throw new Error(
      `Owner share (${ownerShareBps} bps) + platform share (${platformShareBps} bps) must equal ${TOTAL_BASIS_POINTS} bps.`
    );
  }
}

/**
 * Calculates integer satoshi allocations for the community NFT owner and platform.
 * Uses integer floor division for ownerSatoshis and assigns the exact remainder to platformSatoshis
 * so that `ownerSatoshis + platformSatoshis === totalSatoshis` with zero satoshis lost.
 */
export function calculateRevenueAllocation(
  totalSatoshis: number,
  ownerShareBps: number = DEFAULT_OWNER_SHARE_BPS,
  platformShareBps: number = DEFAULT_PLATFORM_SHARE_BPS
): RevenueAllocationResult {
  if (!Number.isInteger(totalSatoshis) || totalSatoshis <= 0) {
    throw new Error(
      `totalSatoshis must be a positive integer, received ${totalSatoshis}.`
    );
  }

  validateRevenuePolicyBps(ownerShareBps, platformShareBps);

  const ownerSatoshis = Math.floor(
    (totalSatoshis * ownerShareBps) / TOTAL_BASIS_POINTS
  );
  const platformSatoshis = totalSatoshis - ownerSatoshis;

  if (ownerSatoshis <= 0 || platformSatoshis <= 0) {
    throw new Error(
      `Total fee (${totalSatoshis} sats) is too small to produce positive integer outputs for both owner (${ownerSatoshis} sats) and platform (${platformSatoshis} sats).`
    );
  }

  return {
    totalSatoshis,
    ownerSatoshis,
    platformSatoshis,
    ownerShareBps,
    platformShareBps,
  };
}

/**
 * Builds a validated PaymentIntent record payload that freezes the verified
 * NFT ownership snapshot (`ownerOutpointSnapshot` and `ownerPayoutScript`)
 * at intent creation time with a short expiration window (default: 120 seconds).
 *
 * Ownership transfers occurring on-chain after intent creation apply to subsequent
 * PaymentIntent records without mutating existing intents.
 */
export function buildPaymentIntentSnapshot(input: PaymentIntentSnapshotInput) {
  if (!isStandardP2PKHScript(input.ownerPayoutScript)) {
    throw new Error(
      'Cannot create PaymentIntent: current NFT owner locking script is not a routable standard P2PKH script.'
    );
  }
  if (!isStandardP2PKHScript(input.platformPayoutScript)) {
    throw new Error(
      'Cannot create PaymentIntent: platform payout script is not a valid standard P2PKH script.'
    );
  }
  if (!/^[0-9a-f]{64}_\d+$/i.test(input.nftOrigin)) {
    throw new Error(
      `Invalid nftOrigin format "${input.nftOrigin}"; expected "<txid>_<vout>".`
    );
  }
  if (!/^[0-9a-f]{64}_\d+$/i.test(input.ownerOutpointSnapshot)) {
    throw new Error(
      `Invalid ownerOutpointSnapshot format "${input.ownerOutpointSnapshot}"; expected "<txid>_<vout>".`
    );
  }

  const allocation = calculateRevenueAllocation(
    input.totalSatoshis,
    input.ownerShareBps,
    input.platformShareBps
  );

  const createdAt = input.now ?? new Date();
  const expirySeconds = input.expirySeconds ?? 120;
  if (!Number.isInteger(expirySeconds) || expirySeconds <= 0) {
    throw new Error('expirySeconds must be a positive integer.');
  }
  const expiresAt = new Date(createdAt.getTime() + expirySeconds * 1000);

  return {
    userId: input.userId,
    communityId: input.communityId,
    actionType: input.actionType,
    totalSatoshis: allocation.totalSatoshis,
    ownerSatoshis: allocation.ownerSatoshis,
    platformSatoshis: allocation.platformSatoshis,
    ownerPayoutScript: input.ownerPayoutScript.toLowerCase(),
    platformPayoutScript: input.platformPayoutScript.toLowerCase(),
    nftOrigin: input.nftOrigin.toLowerCase(),
    ownerOutpointSnapshot: input.ownerOutpointSnapshot.toLowerCase(),
    policyVersion: input.policyVersion,
    status: 'CREATED' as const,
    createdAt,
    expiresAt,
  };
}

/**
 * Evaluates whether a verified payment transaction can transition to CONFIRMED
 * and authorize a PaidActivity.
 *
 * Enforces Correction #5: An observed (0-conf / below-threshold) transaction
 * stays in `OBSERVED` status and MUST NOT authorize a PaidActivity prematurely.
 */
export function evaluatePaymentSettlement(params: {
  outputsVerified: boolean;
  isRejectedOrDoubleSpend: boolean;
  confirmations: number;
  requiredConfirmations: number;
}): PaymentSettlementEvaluation {
  const {
    outputsVerified,
    isRejectedOrDoubleSpend,
    confirmations,
    requiredConfirmations,
  } = params;

  if (!Number.isInteger(requiredConfirmations) || requiredConfirmations < 1) {
    throw new Error(
      `requiredConfirmations must be an integer >= 1, received ${requiredConfirmations}.`
    );
  }
  if (!Number.isInteger(confirmations) || confirmations < 0) {
    throw new Error(
      `confirmations must be a non-negative integer, received ${confirmations}.`
    );
  }

  if (isRejectedOrDoubleSpend || !outputsVerified) {
    return {
      paymentStatus: 'FAILED',
      canAuthorizePaidActivity: false,
      activityStatus: null,
      confirmations,
      requiredConfirmations,
      reason: isRejectedOrDoubleSpend
        ? 'Transaction was rejected or flagged as a double-spend.'
        : 'Transaction outputs do not match required owner and platform allocations.',
    };
  }

  if (confirmations < requiredConfirmations) {
    return {
      paymentStatus: 'OBSERVED',
      canAuthorizePaidActivity: false,
      activityStatus: null,
      confirmations,
      requiredConfirmations,
      reason: `Transaction observed with ${confirmations}/${requiredConfirmations} confirmations; awaiting confirmation threshold before authorizing paid activity.`,
    };
  }

  return {
    paymentStatus: 'CONFIRMED',
    canAuthorizePaidActivity: true,
    activityStatus: 'AUTHORIZED',
    confirmations,
    requiredConfirmations,
    reason: `Transaction confirmed with ${confirmations}/${requiredConfirmations} confirmations.`,
  };
}
