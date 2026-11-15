# BSV Community NFT & Micropayment Proof of Concept

A proof-of-concept application demonstrating that a community can be represented by a transferable **1Sat Ordinal NFT** on **Bitcoin SV (BSV)**, where verified on-chain ownership of that NFT determines who receives **70%** of micropayment revenue from paid community activities (**30%** goes to the platform).

## Core Principles

1. **On-chain authority:** NFT ownership is determined from its current unspent outpoint on-chain. Platform account linkage (`WalletConnection`) is optional — an external wallet can receive the NFT off-platform and still receive its 70% share via its verified locking script.
2. **Protocol-aware script parsing:** the underlying spending condition is extracted from the 1Sat Ordinal envelope; raw ordinal scripts are never copied into payment outputs.
3. **Atomic multi-recipient payment:** one BSV transaction with two outputs (70% owner / 30% platform).
4. **Confirmation-gated settlement:** observed (0-conf) transactions cannot authorize paid activity or transfer ownership.
5. **PaymentIntent snapshot semantics:** each intent snapshots the verified owner outpoint/script at creation with a short expiry; later transfers apply to new intents.
6. **Safe mock mode by default:** `APP_MODE="mock"`. No mainnet broadcast, minting or spending without explicit manual approval.

## Current status: Phase 3 (Community NFT Minting) — complete pending review

Phases 1 (Project Foundation), 2 (Wallet Authentication & Persistence), and 3 (Community Creation, Deterministic 1Sat Ordinal Metadata, Minting Architecture & Independent Mint Verification) are implemented and tested. Phases 4 (Ownership Transfer Indexing) and 5 (Atomic Multi-Output Payments) have **not** been started.

## Database

**13 Prisma models** (`prisma/schema.prisma`), 13 tables + Prisma's `_prisma_migrations`:
`users`, `wallet_connections`, `auth_challenges`, `auth_sessions`, `communities`, `community_nfts`, `ownership_events`, `revenue_policies`, `payment_intents`, `payments`, `payment_allocations`, `paid_activities`, `audit_events`.

Row Level Security is enabled on every table with no anon/authenticated policies (fail-closed for PostgREST; Prisma connects server-side as the `postgres` role).

### Migrations and application status

| Migration | Contents | Clean PostgreSQL 17 (Docker) | Supabase (`snzitranohtepyzgzmxy`) | PGlite (unit tests) |
|---|---|---|---|---|
| `20261115000000_init` | 11 original tables, enums, CHECK constraints, RLS | Applied | Applied | Applied |
| `20261115010000_auth_persistence_and_security_defaults` | `auth_challenges`, `auth_sessions`; `wallet_connections.network/connected/updatedAt`; `audit_events.actorUserId`; indexes, FKs, RLS on new tables; safe defaults (`scriptType='UNVERIFIED'`, `isPayoutRoutable=false`, `PaidActivity.status='PENDING_CONFIRMATION'`) | Applied | Applied | Applied |

The init migration was never edited after being applied. `prisma migrate diff` reports **no drift** between `schema.prisma` and both the clean database and Supabase; `prisma migrate status` reports both up to date.

> Note: the init migration alone creates only 11 tables; the 13-model schema requires **both** migrations.

## Authentication persistence

Challenges, sessions, users, wallet connections and audit events live in PostgreSQL (no in-memory state):

- Challenges are domain-bound, session-bound (when linking), expiring and single-use. Consumption is an atomic `UPDATE ... WHERE usedAt IS NULL AND expiresAt >= now`; only one concurrent verification can win.
- `(provider, identityKey)` is unique at the database level; linking a wallet owned by another account returns `409 UNAUTHORIZED_WALLET_LINK`.
- Sessions are HMAC-signed cookie tokens backed by `auth_sessions` rows (HttpOnly, SameSite=Lax, Secure in production/live); logout and wallet disconnect revoke the row, so every app instance rejects the session immediately.

## Production configuration

In `NODE_ENV=production` or `APP_MODE=live`, startup/config validation **fails** if:
- `DATABASE_URL` is missing or points at localhost (`localhost`, `127.0.0.1`, `[::1]`) — no silent local fallback,
- `prisma.config.ts` (`resolveMigrationDatabaseUrl`) receives a missing or localhost (`localhost`, `127.0.0.1`, `[::1]`) `DIRECT_URL`/`DATABASE_URL`,
- `SESSION_SECRET` is missing, shorter than 32 characters, or a known development placeholder.

Local development keeps mock mode (`APP_MODE="mock"`) and the local database fallback.

## Phase 3: Community creation, deterministic 1Sat metadata, and independent mint verification

- **Community creation (`/communities/new`, `POST /api/communities`):**
  - Requires an authenticated server session (`originalCreatorId` is derived strictly from the server session).
  - Validates `name`, `slug` (normalized lowercase URL-safe slug), `description`, and optional `artworkUrl` via Zod.
  - Rejects duplicate slugs (`409 DUPLICATE_SLUG`).
  - Persists the community in PostgreSQL with `status = 'PENDING_MINT'` and an initial `RevenuePolicy` (`7000` bps owner / `3000` bps platform) with `currentOwnerScript = null`.
- **Deterministic Version 1 1Sat Ordinal metadata (`src/lib/ordinals/metadata.ts`):**
  - Canonical JSON with lexicographically ordered keys (`app`, `artworkUrl`, `communityId`, `description`, `name`, `platform`, `schemaVersion`, `type`) and NFC-normalized UTF-8 strings.
- **Modular minting (`src/adapters/ordinals/*`):**
  - `MockMintingAdapter` constructs genuine 1Sat Ordinal inscription locking scripts (`OP_FALSE OP_IF "ord" OP_1 "application/json" OP_0 <canonical-json-bytes> OP_ENDIF <25-byte-P2PKH>`) in an in-memory transaction store without network broadcast.
  - `OneSatMintingAdapter` wraps `@1sat/actions` (`inscribe.execute`) and `@1sat/client` (`OneSatServices`) for live mode (`APP_MODE="live"`), gated against accidental execution in mock mode.
- **Independent mint verification (`src/lib/ordinals/mint-verification-service.ts`):**
  - A community **never** transitions to `ACTIVE` from client-supplied transaction claims alone.
  - `MintVerificationService` independently fetches the transaction from the chain lookup provider, verifies network match (`BSV_NETWORK`), output existence, 1-satoshi output value, valid 1Sat `"ord"` inscription envelope, deterministic metadata schema & `communityId` match, permanent origin (`<txid>_<vout>`), standard 25-byte P2PKH spending condition (`scriptType = 'P2PKH'`, `isPayoutRoutable = true`), and required confirmation threshold (`confirmations >= OWNERSHIP_CONFIRMATIONS_REQUIRED`).
  - Only when verified and confirmed does it set `Community.status = 'ACTIVE'` and assign `Community.currentOwnerScript` from the verified on-chain NFT output's locking script.

## Wallet integration architecture & testing status

| Provider | Status |
|---|---|
| Mock | Fully tested (deterministic `@bsv/sdk` ProtoWallet for auth + `MockMintingAdapter` for 1Sat Ordinal inscription scripts). |
| Yours (BRC-100 `window.CWI` primary & `window.yours` legacy auth-only fallback) | Implemented end-to-end (explicit selection via `AppWalletProvider`, BRC-42 `deriveDestination()`, live `@1sat/actions` `inscribe` minting on `window.CWI`, multi-output `vout` extraction). **Automated tests run against simulated `ProtoWallet`/BSM fixtures; manual test checklist against the real browser extension is documented in `docs/TEST_PLAN.md`.** |
| HandCash Desktop BRC Wallet (`https://127.0.0.1:2121` / `http://127.0.0.1:3321`) | Implemented end-to-end (ordered HTTP bridge probing, `getVersion` `'handcash'` enforcement, `AppWalletProvider`, BRC-42 `deriveDestination()`, live `createAction` + `signAction` 1Sat Ordinal minting via `@1sat/templates`, multi-output `vout` extraction). **Automated tests run against simulated BRC-100 substrates; manual test checklist against HandCash Desktop is documented in `docs/TEST_PLAN.md`. HandCash Mobile alone is not supported (requires Desktop BRC-100 HTTP bridge).** |

Automated tests prove our adapters, destination proof verification, transaction output parsing, and server verification logic are self-consistent; final real-wallet confirmation still requires executing the manual browser checklist in `docs/TEST_PLAN.md` on `BSV_NETWORK="test"`.

Design notes:
- Providers are always selected explicitly via `AppWalletProvider` (`src/context/wallet-context.tsx`) — never `WalletClient('auto')` or `@1sat/react`'s auto-racing `connectWallet()`, and vendor-version checks reject mismatched providers (`PROVIDER_MISMATCH`).
- Server-enforced network: the server enforces its configured `BSV_NETWORK` (`'main' | 'test'`) and rejects any client-supplied network mismatch (`400 NETWORK_MISMATCH`). Mainnet minting stays blocked unless `ALLOW_MAINNET_MINT=true` is explicitly authorized.
- Separation of identity keys and payment keys: BRC-100 `identityKey` is NEVER used as a payout script. Clients must explicitly run `deriveDestination()` (deriving a separate BRC-42 child payment key) and submit a cryptographic `destinationProof` verified via `/api/auth/verify`, `/api/wallets/connect`, or `/api/wallets/destination`. Initial community ownership (`Community.currentOwnerScript`) remains strictly authoritative from the verified on-chain locking script of the actual minted 1Sat Ordinal output.

## Quick start

1. Copy `.env.example` to `.env` and set `DATABASE_URL` (Supabase transaction pooler, port 6543), `DIRECT_URL` (session pooler / direct, port 5432; URL-encode special characters in passwords) and a strong `SESSION_SECRET`.
2. `npm install`
3. `npm run db:generate` and `npm run db:validate`
4. Apply migrations: `npx prisma migrate deploy`
5. `npm run typecheck` and `npm test`
6. `npm run dev` (mock mode by default; set `BSV_NETWORK="test"` and follow `docs/TEST_PLAN.md` for live wallet testing)

### Running the real-PostgreSQL integration tests

`tests/integration/auth-postgres.test.ts` runs only if `TEST_DATABASE_URL` points to a **disposable** database that already has all migrations applied (the tests delete users/sessions). Without it the suite is reported as *skipped*. CI runs it against a `postgres:17` service container.

## Remaining limitations

- Automated tests cannot launch the real Yours Chrome extension or HandCash Desktop native app; follow the manual testnet verification checklists in `docs/TEST_PLAN.md`.
- HandCash Mobile lacks a local BRC-100 HTTP bridge and cannot perform BRC-100 desktop signing/minting directly without HandCash Desktop.
- Phases 4 (transfer indexing) and 5 (`sendOutputs` 70/30 payments) are outside this phase.
- No rate limiting on `/api/auth/*`; no periodic cleanup of expired challenges/sessions.
- Integration suite was not run against Supabase (it is destructive); Supabase was verified via migration status, schema-drift diff and column-default inspection.
- Phases 4+ (ownership transfer indexing, atomic multi-output payments) are not implemented yet.
