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
   - Executes the initial migration (`prisma/migrations/20261115000000_init/migration.sql`, covering all 11 Prisma models, foreign-key indexes, domain `CHECK` constraints, and `ENABLE ROW LEVEL SECURITY`) against an embedded `PGlite` PostgreSQL engine. The identical DDL has also been applied and verified on the live Supabase PostgreSQL 17 project (`community-nft-poc`, ref `snzitranohtepyzgzmxy`, migration `init_community_nft_poc`) with RLS confirmed enabled on all 11 tables and Supabase security/performance advisors checked.
   - Verifies schema & domain constraints:
     - Optional `currentOwnerWalletConnectionId` with required on-chain `currentOwnerScript`.
     - Unique `(provider, identityKey)` on `WalletConnection`.
     - Unique `origin` (`<originTxid>_<originVout>`) and `communityId` on `CommunityNFT`.
     - Unique `transactionId` and `paymentIntentId` on `Payment` (duplicate payment rejection).
     - `PaymentIntent` ownership snapshot preservation across subsequent NFT ownership changes.
     - Payment state machine enforcement: `OBSERVED` (unconfirmed) payments cannot authorize a `PaidActivity`; only `CONFIRMED` payments reaching `PAYMENT_CONFIRMATIONS_REQUIRED` can authorize a `PaidActivity`.
4. **Environment Configuration Validation Tests (`tests/unit/env-config.test.ts`):**
   - Verifies `APP_MODE="mock"` default, basis points invariants, P2PKH script validation, and confirmation threshold validation.

## Phase 2 — Wallet Authentication & Multi-Provider Lifecycle Tests (Implemented)

5. **Wallet Authentication & Multi-Provider Tests (`tests/unit/wallet-auth.test.ts`):**
   - **Test 0:** Full `MockWalletAdapter` authentication lifecycle and `WalletConnectionStateManager` transitions (`disconnected` -> `connecting` -> `connected` -> `authenticating` -> `authenticated`).
   - **Test 1:** Successful Yours Wallet authentication across both supported transports (BRC-100 `window.CWI` `createSignature` and injected `window.yours.signMessage` BSM).
   - **Test 2:** Successful HandCash BRC-100 authentication (`createSignature` verification and session issuance).
   - **Test 3:** Failed authentication rejection (wrong signing key claiming another identity's public key, and domain binding mismatch).
   - **Test 4:** Expired authentication challenge rejection (`CHALLENGE_EXPIRED`).
   - **Test 5:** Reused authentication challenge rejection (`CHALLENGE_REUSED` single-use replay protection).
   - **Test 6:** Unsupported wallet operation enforcement (`sendOutputs` and `mintOrdinal` throwing `UnsupportedWalletOperationError` in Phase 2 across Mock, Yours, and HandCash adapters).
   - **Test 7:** Wallet disconnection (adapter state cleanup, server wallet connection status update, and session revocation when the last connected wallet is disconnected).
   - **Test 8:** Session expiration and HMAC-SHA256 tamper rejection.
   - **Test 9:** Linking an additional wallet to an existing account (e.g., linking HandCash to an account already authenticated with Yours Wallet) and blocking unauthorized cross-account wallet claiming (`409 Conflict` `UNAUTHORIZED_WALLET_LINK`).
   - **Test 10:** Explicit provider selection when both Yours and HandCash are available simultaneously, plus vendor version prefix mismatch protection (`PROVIDER_MISMATCH`).

## Subsequent Phase Tests (Phases 3–6)

- **Phase 3:** Community creation, 1Sat Ordinal minting, and origin verification.
- **Phase 4:** Ownership indexing, transfer detection, and confirmation threshold gating.
- **Phase 5:** End-to-end multi-output payment intent creation, transaction verification, and security rejection tests.
- **Phase 6:** Full Alice-to-Bob NFT transfer and 70/30 revenue routing switch test.
