# Architecture Overview

## 1. System Components

1. **Frontend (Next.js App Router, React 19, TypeScript):**
   - Connects to wallets via the unified `WalletAdapter` interface.
   - Displays community status, NFT origin/outpoint lineage, revenue splits, and mock/live mode indicators.
2. **Authentication Service (`src/lib/auth`):**
   - Issues single-use, domain-bound, expiring cryptographic challenges persisted in PostgreSQL (`auth_challenges`).
   - Verifies BRC-100 / BSM wallet signatures, enforces the server-configured `BSV_NETWORK` (rejecting client-supplied network mismatches), and binds authenticated sessions via `HttpOnly` cookies backed by `auth_sessions`.
   - Never silently derives a payment destination (`currentPayoutScript`) from an authentication `identityKey`.
3. **Community & NFT Minting Service (`src/lib/communities`, `src/lib/ordinals`, `src/adapters/ordinals`):**
   - `CommunityService` (`src/lib/communities/community-service.ts`) validates community creation via Zod, enforces normalized unique slugs, binds `originalCreatorId` from the authenticated server session, and creates communities in `PENDING_MINT` status with an initial 70/30 `RevenuePolicy`.
   - `metadata.ts` (`src/lib/ordinals/metadata.ts`) constructs and validates deterministic Version 1 1Sat Ordinals JSON metadata (`CommunityNftMetadataV1`) with canonical alphabetical key ordering and NFC Unicode normalization.
   - `MockMintingAdapter` (`src/adapters/ordinals/mock-minting.adapter.ts`) and `OneSatMintingAdapter` (`src/adapters/ordinals/onesat-minting.adapter.ts`) implement the modular `OrdinalMintingAdapter` interface (`src/adapters/ordinals/minting-adapter.ts`).
   - `MintVerificationService` (`src/lib/ordinals/mint-verification-service.ts`) independently verifies minted transactions against the chain lookup provider (transaction existence, network match, output index, 1-satoshi value, 1Sat `"ord"` inscription envelope, deterministic community metadata match, permanent origin `<txid>_<vout>`, standard 25-byte P2PKH locking script, and confirmation threshold `OWNERSHIP_CONFIRMATIONS_REQUIRED`) before activating a community (`status = 'ACTIVE'`) and setting `Community.currentOwnerScript` from the verified on-chain NFT output.
4. **Ownership Indexing Service (`src/adapters/blockchain` & `src/lib/ordinals` — Phase 4):**
   - Resolves current unspent ordinal outputs from 1Sat Stack (`@1sat/client`) or `MockIndexerAdapter`.
   - Extracts the underlying spending condition script from the 1Sat Ordinal envelope and verifies whether it is a standard 25-byte P2PKH script (`76a914<20-byte-pkh>88ac`).
   - Enforces `OWNERSHIP_CONFIRMATIONS_REQUIRED` before updating active payout routing.
5. **Payment Service (`src/lib/payments` — Phase 5):**
   - Computes integer satoshi 70/30 splits (`ownerShareBps >= 5000`, `ownerShareBps + platformShareBps == 10000`).
   - Creates short-lived `PaymentIntent` records with an immutable ownership snapshot (`ownerOutpointSnapshot`, `ownerPayoutScript`).
   - Independently verifies submitted transactions (`SUBMITTED` -> `OBSERVED` -> `CONFIRMED`) and only authorizes `PaidActivity` once `PAYMENT_CONFIRMATIONS_REQUIRED` is satisfied.
6. **Database (Supabase PostgreSQL 17 + Prisma 7 — 13 Models):**
   - Configured via `prisma.config.ts` (`resolveMigrationDatabaseUrl`, which rejects missing or localhost URLs in `NODE_ENV=production` or `APP_MODE=live`) and `@prisma/adapter-pg` (`PrismaPg`).
   - Defines 13 Prisma models: `User`, `WalletConnection`, `AuthChallenge`, `AuthSession`, `Community`, `CommunityNFT`, `OwnershipEvent`, `RevenuePolicy`, `PaymentIntent`, `Payment`, `PaymentAllocation`, `PaidActivity`, and `AuditEvent`.
   - **Supabase Deployment & Security:** Both migrations (`20261115000000_init` and `20261115010000_auth_persistence_and_security_defaults`) are applied and verified on the live Supabase PostgreSQL 17 project `community-nft-poc` (ref `snzitranohtepyzgzmxy`, region `us-east-1`), with Row Level Security (`ENABLE ROW LEVEL SECURITY`) active on all 13 `public` tables to prevent unauthorized PostgREST `anon`/`authenticated` access while server-side Prisma runs with database privileges, in addition to local `PGlite` automated testing.

## 2. Authority & Trust Boundaries

- **Blockchain Authority:** The database caches ownership state, but the blockchain indexer is queried before issuing any new `PaymentIntent`.
- **Optional Platform Account Linkage:** `Community.currentOwnerScript` and `CommunityNFT.currentOwnerScript` hold the verified on-chain locking script. `Community.currentOwnerWalletConnectionId` is nullable because an NFT may be transferred to any external BSV wallet whose owner has never registered on the platform.
- **Zero Client Trust:** The frontend never supplies payout scripts, fee percentages, or unverified confirmation claims.
- **Mock vs. Live Mode Separation:** `APP_MODE="mock"` is the default. Mock records are flagged with `isMock = true` so simulated transactions can never be confused with verified mainnet transactions.
