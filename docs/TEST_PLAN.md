# Test Plan

## Phase 1 — Project Foundation Tests (Implemented)

1. **Revenue Calculation Unit Tests (`tests/unit/revenue-calculator.test.ts`):**
   - Verifies 70/30 integer satoshi floor math (`10,000` sats -> `7,000` owner / `3,000` platform).
   - Verifies odd satoshi amounts preserve exact total sum (`ownerSatoshis + platformSatoshis === totalSatoshis`) with zero satoshis lost or fabricated.
   - Enforces minimum 50% (`5000` bps) owner share invariant and `ownerShareBps + platformShareBps === 10000` invariant.
   - Rejects negative, zero, non-integer, or dust/zero-output fee amounts.
2. **Protocol-Aware 1Sat Script Parser Unit Tests (`tests/unit/script-parser.test.ts`):**
   - Extracts clean 25-byte P2PKH script from prefixed 1Sat Ordinal inscription envelope (`OP_FALSE OP_IF "ord" ... OP_ENDIF <P2PKH>`).
   - Extracts clean 25-byte P2PKH script from suffixed inscription envelope (`<P2PKH> OP_FALSE OP_IF "ord" ... OP_ENDIF`) and trailing `OP_RETURN` MAP metadata.
   - Rejects non-standard / custom / OrdLock scripts and marks `isPayoutRoutable = false`.
3. **Database Constraint & Payment State Machine Tests (`tests/unit/database-constraints.test.ts`):**
   - Verifies schema & domain constraints:
     - Optional `currentOwnerWalletConnectionId` with required on-chain `currentOwnerScript`.
     - Unique `(provider, identityKey)` on `WalletConnection`.
     - Unique `origin` (`<originTxid>_<originVout>`) and `communityId` on `CommunityNFT`.
     - Unique `transactionId` and `paymentIntentId` on `Payment` (duplicate payment rejection).
     - `PaymentIntent` ownership snapshot preservation across subsequent NFT ownership changes.
     - Payment state machine enforcement: `OBSERVED` (unconfirmed) payments cannot authorize a `PaidActivity`; only `CONFIRMED` payments reaching `PAYMENT_CONFIRMATIONS_REQUIRED` can authorize a `PaidActivity`.
4. **Environment Configuration Validation Tests (`tests/unit/env-config.test.ts`):**
   - Verifies `APP_MODE="mock"` default, basis points invariants, P2PKH script validation, and confirmation threshold validation.

## Subsequent Phase Tests (Phases 2–6)

- **Phase 2:** Yours, HandCash, and Mock challenge-response authentication, nonce single-use enforcement, and expired challenge rejection.
- **Phase 3:** Community creation, 1Sat Ordinal minting, and origin verification.
- **Phase 4:** Ownership indexing, transfer detection, and confirmation threshold gating.
- **Phase 5:** End-to-end multi-output payment intent creation, transaction verification, and security rejection tests.
- **Phase 6:** Full Alice-to-Bob NFT transfer and 70/30 revenue routing switch test.
