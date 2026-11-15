# Architecture Overview

## 1. System Components

1. **Frontend (Next.js App Router, React 19, TypeScript):**
   - Connects to wallets via the unified `WalletAdapter` interface.
   - Displays community status, NFT origin/outpoint lineage, revenue splits, and mock/live mode indicators.
2. **Authentication Service (`src/lib/auth`):**
   - Issues single-use, domain-bound, expiring cryptographic challenges.
   - Verifies BRC-100 / BRC-77 wallet signatures and binds authenticated sessions via `HttpOnly` cookies.
3. **Community NFT Service (`src/lib/ordinals`):**
   - Manages community creation, 1Sat Ordinal mint intents, permanent origin (`<origin_txid>_<vout>`) tracking, and protocol-aware locking script extraction.
4. **Ownership Indexing Service (`src/adapters/blockchain` & `src/lib/ordinals`):**
   - Resolves current unspent ordinal outputs from 1Sat Stack (`@1sat/client`) or `MockIndexerAdapter`.
   - Extracts the underlying spending condition script from the 1Sat Ordinal envelope and verifies whether it is a standard 25-byte P2PKH script (`76a914<20-byte-pkh>88ac`).
   - Enforces `OWNERSHIP_CONFIRMATIONS_REQUIRED` before updating active payout routing.
5. **Payment Service (`src/lib/payments`):**
   - Computes integer satoshi 70/30 splits (`ownerShareBps >= 5000`, `ownerShareBps + platformShareBps == 10000`).
   - Creates short-lived `PaymentIntent` records with an immutable ownership snapshot (`ownerOutpointSnapshot`, `ownerPayoutScript`).
   - Independently verifies submitted transactions (`SUBMITTED` -> `OBSERVED` -> `CONFIRMED`) and only authorizes `PaidActivity` once `PAYMENT_CONFIRMATIONS_REQUIRED` is satisfied.
6. **Database (Supabase PostgreSQL + Prisma 7 — 11 Models):**
   - Configured via `prisma.config.ts` and `@prisma/adapter-pg` (`PrismaPg`).
   - Defines 11 Prisma models: `User`, `WalletConnection`, `Community`, `CommunityNFT`, `OwnershipEvent`, `RevenuePolicy`, `PaymentIntent`, `Payment`, `PaymentAllocation`, `PaidActivity`, and `AuditEvent`.
   - Note: The initial migration (`prisma/migrations/20261115000000_init/migration.sql`) has been verified against an embedded PGlite PostgreSQL instance in automated tests, and has not yet been applied to an external PostgreSQL or Supabase instance.

## 2. Authority & Trust Boundaries

- **Blockchain Authority:** The database caches ownership state, but the blockchain indexer is queried before issuing any new `PaymentIntent`.
- **Optional Platform Account Linkage:** `Community.currentOwnerScript` and `CommunityNFT.currentOwnerScript` hold the verified on-chain locking script. `Community.currentOwnerWalletConnectionId` is nullable because an NFT may be transferred to any external BSV wallet whose owner has never registered on the platform.
- **Zero Client Trust:** The frontend never supplies payout scripts, fee percentages, or unverified confirmation claims.
- **Mock vs. Live Mode Separation:** `APP_MODE="mock"` is the default. Mock records are flagged with `isMock = true` so simulated transactions can never be confused with verified mainnet transactions.
