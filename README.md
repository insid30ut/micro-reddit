# BSV Community NFT & Micropayment Proof of Concept

A proof-of-concept application demonstrating that a community can be represented by a transferable **1Sat Ordinal NFT** on **Bitcoin SV (BSV)**, where verified on-chain ownership of that NFT determines who receives **70%** of micropayment revenue from paid community activities (**30%** goes to the platform).

## Core Principles

1. **On-chain authority:** NFT ownership is determined from its current unspent outpoint on-chain. Platform account linkage (`WalletConnection`) is optional — an external wallet can receive the NFT off-platform and still receive its 70% share via its verified locking script.
2. **Protocol-aware script parsing:** the underlying spending condition is extracted from the 1Sat Ordinal envelope; raw ordinal scripts are never copied into payment outputs.
3. **Atomic multi-recipient payment:** one BSV transaction with two outputs (70% owner / 30% platform).
4. **Confirmation-gated settlement:** observed (0-conf) transactions cannot authorize paid activity or transfer ownership.
5. **PaymentIntent snapshot semantics:** each intent snapshots the verified owner outpoint/script at creation with a short expiry; later transfers apply to new intents.
6. **Safe mock mode by default:** `APP_MODE="mock"`. No mainnet broadcast, minting or spending without explicit manual approval.

## Current status: Phase 2 (Wallet Authentication) — complete pending review

Phase 3 (community creation / minting) has **not** been started.

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
- `DATABASE_URL` is missing or points at localhost (no silent local fallback; `prisma.config.ts` likewise requires `DIRECT_URL`/`DATABASE_URL`),
- `SESSION_SECRET` is missing, shorter than 32 characters, or a known development placeholder.

Local development keeps mock mode and the local database fallback.

## Wallet integration testing status

| Provider | Status |
|---|---|
| Mock | Fully tested (deterministic `@bsv/sdk` ProtoWallet). |
| Yours (BRC-100 `window.CWI` and `window.yours` extension) | **Simulated only.** Tested against `ProtoWallet`/BSM fixtures that imitate the provider interface. **Not tested against a real Yours extension.** |
| HandCash (BRC-100 substrate) | **Simulated only.** **Not tested against a real HandCash wallet.** |

Simulated tests prove our adapter + server verification logic is self-consistent; they do **not** prove real-provider behavior (actual key semantics, exact network strings, prompt flows, signature encodings). Real-wallet testing must be done manually in a browser with each wallet installed.

Design notes: providers are always selected explicitly (never `auto`), vendor-version checks reject a mismatched provider, and the server derives the payout script from the verified `identityKey`. If a real wallet's signing/payment keys differ from its identity key, revenue routing in later phases must use scripts verified on-chain, not client-reported ones.

## Quick start

1. Copy `.env.example` to `.env` and set `DATABASE_URL` (Supabase transaction pooler, port 6543), `DIRECT_URL` (session pooler / direct, port 5432; URL-encode special characters in passwords) and a strong `SESSION_SECRET`.
2. `npm install`
3. `npm run db:generate` and `npm run db:validate`
4. Apply migrations: `npx prisma migrate deploy`
5. `npm run typecheck` and `npm test`
6. `npm run dev` (mock mode by default)

### Running the real-PostgreSQL integration tests

`tests/integration/auth-postgres.test.ts` runs only if `TEST_DATABASE_URL` points to a **disposable** database that already has all migrations applied (the tests delete users/sessions). Without it the suite is reported as *skipped*. CI runs it against a `postgres:17` service container.

## Remaining limitations

- No real-wallet (Yours/HandCash) testing yet.
- No rate limiting on `/api/auth/*`; no periodic cleanup of expired challenges/sessions.
- Integration suite was not run against Supabase (it is destructive); Supabase was verified via migration status, schema-drift diff and column-default inspection.
- Phases 3+ (minting, payments, ownership indexing) are not implemented.
