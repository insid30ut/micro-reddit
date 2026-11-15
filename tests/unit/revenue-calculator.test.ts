import { describe, expect, it } from 'vitest';
import {
  buildPaymentIntentSnapshot,
  calculateRevenueAllocation,
  evaluatePaymentSettlement,
  validateRevenuePolicyBps,
} from '@/lib/payments/revenue-calculator';

const ALICE_P2PKH = '76a914111111111111111111111111111111111111111188ac';
const PLATFORM_P2PKH = '76a914000000000000000000000000000000000000000188ac';
const SAMPLE_ORIGIN =
  'e17d7856c375640427943395d2341b6ed75f73afc8b22bb3681987278978a584_0';

describe('Revenue Calculation & Policy Invariants', () => {
  it('calculates the standard 70/30 split for 10,000 satoshis', () => {
    const result = calculateRevenueAllocation(10_000, 7_000, 3_000);
    expect(result).toEqual({
      totalSatoshis: 10_000,
      ownerSatoshis: 7_000,
      platformSatoshis: 3_000,
      ownerShareBps: 7_000,
      platformShareBps: 3_000,
    });
  });

  it('uses integer floor division and preserves exact satoshi sum for odd amounts', () => {
    const oddAmounts = [101, 333, 1_001, 9_999, 10_001, 123_457];
    for (const total of oddAmounts) {
      const result = calculateRevenueAllocation(total, 7_000, 3_000);
      expect(Number.isInteger(result.ownerSatoshis)).toBe(true);
      expect(Number.isInteger(result.platformSatoshis)).toBe(true);
      expect(result.ownerSatoshis).toBe(Math.floor((total * 7_000) / 10_000));
      expect(result.ownerSatoshis + result.platformSatoshis).toBe(total);
    }
  });

  it('rejects ownerShareBps below 5000 (50% minimum requirement)', () => {
    expect(() => validateRevenuePolicyBps(4_999, 5_001)).toThrow(
      /at least 5000 bps/i
    );
    expect(() => calculateRevenueAllocation(10_000, 4_000, 6_000)).toThrow(
      /at least 5000 bps/i
    );
  });

  it('rejects basis points that do not sum to 10,000', () => {
    expect(() => validateRevenuePolicyBps(7_000, 2_500)).toThrow(
      /must equal 10000 bps/i
    );
    expect(() => validateRevenuePolicyBps(7_000, 3_001)).toThrow(
      /must equal 10000 bps/i
    );
  });

  it('rejects non-integer, zero, negative, or un-splittable totalSatoshis', () => {
    expect(() => calculateRevenueAllocation(0)).toThrow(/positive integer/i);
    expect(() => calculateRevenueAllocation(-500)).toThrow(/positive integer/i);
    expect(() => calculateRevenueAllocation(100.5)).toThrow(/positive integer/i);
    expect(() => calculateRevenueAllocation(1)).toThrow(/too small/i);
  });
});

describe('PaymentIntent Ownership Snapshot & Settlement States', () => {
  it('captures an immutable ownership snapshot with default 120s expiration', () => {
    const now = new Date('2026-11-15T00:00:00.000Z');
    const intent = buildPaymentIntentSnapshot({
      userId: 'user_payer_1',
      communityId: 'comm_1',
      actionType: 'SUBMIT_PAID_ACTIVITY',
      totalSatoshis: 10_000,
      ownerShareBps: 7_000,
      platformShareBps: 3_000,
      ownerPayoutScript: ALICE_P2PKH,
      platformPayoutScript: PLATFORM_P2PKH,
      nftOrigin: SAMPLE_ORIGIN,
      ownerOutpointSnapshot: SAMPLE_ORIGIN,
      policyVersion: 1,
      now,
    });

    expect(intent.ownerSatoshis).toBe(7_000);
    expect(intent.platformSatoshis).toBe(3_000);
    expect(intent.ownerOutpointSnapshot).toBe(SAMPLE_ORIGIN);
    expect(intent.ownerPayoutScript).toBe(ALICE_P2PKH);
    expect(intent.status).toBe('CREATED');
    expect(intent.expiresAt.getTime() - now.getTime()).toBe(120_000);
  });

  it('rejects PaymentIntent creation if ownerPayoutScript is not a standard P2PKH script', () => {
    expect(() =>
      buildPaymentIntentSnapshot({
        userId: 'user_payer_1',
        communityId: 'comm_1',
        actionType: 'SUBMIT_PAID_ACTIVITY',
        totalSatoshis: 10_000,
        ownerShareBps: 7_000,
        platformShareBps: 3_000,
        ownerPayoutScript: '0063036f726451', // raw ord script fragment, not clean P2PKH
        platformPayoutScript: PLATFORM_P2PKH,
        nftOrigin: SAMPLE_ORIGIN,
        ownerOutpointSnapshot: SAMPLE_ORIGIN,
        policyVersion: 1,
      })
    ).toThrow(/not a routable standard P2PKH script/i);
  });

  it('prevents an OBSERVED (0-conf or below-threshold) transaction from authorizing a PaidActivity', () => {
    const evaluationZeroConf = evaluatePaymentSettlement({
      outputsVerified: true,
      isRejectedOrDoubleSpend: false,
      confirmations: 0,
      requiredConfirmations: 1,
    });

    expect(evaluationZeroConf.paymentStatus).toBe('OBSERVED');
    expect(evaluationZeroConf.canAuthorizePaidActivity).toBe(false);
    expect(evaluationZeroConf.activityStatus).toBeNull();

    const evaluationPartialConf = evaluatePaymentSettlement({
      outputsVerified: true,
      isRejectedOrDoubleSpend: false,
      confirmations: 1,
      requiredConfirmations: 2,
    });

    expect(evaluationPartialConf.paymentStatus).toBe('OBSERVED');
    expect(evaluationPartialConf.canAuthorizePaidActivity).toBe(false);
    expect(evaluationPartialConf.activityStatus).toBeNull();
  });

  it('authorizes PaidActivity ONLY when confirmations meet or exceed requiredConfirmations', () => {
    const confirmedEval = evaluatePaymentSettlement({
      outputsVerified: true,
      isRejectedOrDoubleSpend: false,
      confirmations: 2,
      requiredConfirmations: 2,
    });

    expect(confirmedEval.paymentStatus).toBe('CONFIRMED');
    expect(confirmedEval.canAuthorizePaidActivity).toBe(true);
    expect(confirmedEval.activityStatus).toBe('AUTHORIZED');
  });

  it('marks payment as FAILED and blocks authorization when outputs fail verification or double-spend occurs', () => {
    const failedOutputs = evaluatePaymentSettlement({
      outputsVerified: false,
      isRejectedOrDoubleSpend: false,
      confirmations: 3,
      requiredConfirmations: 1,
    });
    expect(failedOutputs.paymentStatus).toBe('FAILED');
    expect(failedOutputs.canAuthorizePaidActivity).toBe(false);

    const doubleSpend = evaluatePaymentSettlement({
      outputsVerified: true,
      isRejectedOrDoubleSpend: true,
      confirmations: 1,
      requiredConfirmations: 1,
    });
    expect(doubleSpend.paymentStatus).toBe('FAILED');
    expect(doubleSpend.canAuthorizePaidActivity).toBe(false);
  });
});
