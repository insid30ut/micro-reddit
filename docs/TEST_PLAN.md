# Test Plan

## Phase 1 — Project Foundation Tests (Implemented)

1. **Revenue Calculation Unit Tests (`tests/unit/revenue-calculator.test.ts` — 10 Tests):**
   - Verifies 70/30 integer satoshi floor math (`10,000` sats -> `7,000` owner / `3,000` platform).
   - Verifies odd satoshi amounts preserve exact total sum with zero satoshis lost or fabricated.
   - Enforces minimum 50% (`5000` bps) owner share invariant and `ownerShareBps + platformShareBps === 10000` invariant.
   - Rejects negative, zero, non-integer, or dust/zero-output fee amounts.
2. **Protocol-Aware 1Sat Script Parser Unit Tests (`tests/unit/script-parser.test.ts` — 5 Tests):**
   - Extracts clean 25-byte P2PKH script from prefixed and suffixed 1Sat Ordinal inscription envelopes plus trailing `OP_RETURN` MAP metadata.
   - Rejects non-standard / custom / OrdLock scripts and marks `isPayoutRoutable = false`.
3. **Database Constraint & Payment State Machine Tests (`tests/unit/database-constraints.test.ts` — 4 Tests):**
   - Executes PostgreSQL migrations (`20261115000000_init` and `20261115010000_auth_persistence_and_security_defaults`) against `PGlite`.
   - Enforces unique constraints, `PaymentIntent` ownership snapshots, safe schema defaults (`scriptType='UNVERIFIED'`, `isPayoutRoutable=false`, `PaidActivity.status='PENDING_CONFIRMATION'`), and `CONFIRMED`-only settlement gating.
4. **Environment Configuration Validation Tests (`tests/unit/env-config.test.ts` — 7 Tests):**
   - Verifies `APP_MODE="mock"` default, `SESSION_SECRET` production checks, localhost rejection in live/production mode, basis points invariants, and confirmation thresholds.

## Phase 2 & Wallet Integration — Multi-Provider BRC-100 & Destination Proof Tests (Implemented)

5. **Wallet Authentication & Multi-Provider Tests (`tests/unit/wallet-auth.test.ts` — 20 Tests):**
   - **Test 0:** Full `MockWalletAdapter` authentication lifecycle and state transitions.
   - **Test 1:** Yours Wallet authentication across simulated BRC-100 `window.CWI` (`brc100`) and legacy injected `window.yours.signMessage` (`bsm`).
   - **Test 2:** HandCash BRC-100 authentication (`createSignature` verification and session issuance).
   - **Test 3–5:** Wrong signing key / domain mismatch rejection, challenge expiry (`CHALLENGE_EXPIRED`), and single-use replay rejection (`CHALLENGE_REUSED`).
   - **Test 6:** `UnsupportedWalletOperationError` for `sendOutputs` (Phase 5) and legacy `window.yours` `mintOrdinal`, plus blocking live BRC-100 minting when `APP_MODE="mock"`.
   - **Test 7–9:** Wallet disconnection, session expiration/tampering rejection, multi-wallet linking, and unauthorized cross-account claim prevention (`409 UNAUTHORIZED_WALLET_LINK`).
   - **Test 10:** Explicit provider selection and vendor version mismatch rejection (`PROVIDER_MISMATCH`).
   - **Tests 11–14:** Persistent PostgreSQL storage for users/wallets/challenges/sessions/audit events, atomic concurrent challenge replay protection, cross-instance revocation propagation, and production `SESSION_SECRET`/cookie checks.
   - **Test 15:** Server-enforced `BSV_NETWORK` and non-derivation of `payoutScript` from raw `identityKey`.
   - **Test 16:** Yours `window.CWI` global detection, `getWalletInterface()` retention, and capability differentiation (`canMintOrdinal: true` vs `false` on legacy `window.yours`).
   - **Test 17:** HandCash Desktop bridge probing (`https://127.0.0.1:2121` primary -> `http://127.0.0.1:3321` fallback), `PROVIDER_MISMATCH` on non-HandCash version, and normalization of locked/rejected/network errors.
   - **Test 18:** Explicit `discoverAvailableWallets` + `createExplicitWalletAdapter` behavior when both Yours and HandCash exist simultaneously.
   - **Test 19:** BRC-42 `deriveDestination()` separation from `identityKey`, cryptographic `verifyDestinationOwnershipProof`, rejection of unproven `payoutScript` or root-key spoofed proofs (`INVALID_DESTINATION_PROOF`), and `WalletAuthService.updateVerifiedWalletDestination()` persistence.

## Phase 3 — Community Creation, 1Sat Minting & Verification Tests (Implemented)

6. **Community Creation & NFT Minting Tests (`tests/unit/community-minting.test.ts` — 14 Tests):**
   - **Tests 1–4:** `PENDING_MINT` community creation, duplicate slug rejection (`409`), unauthenticated rejection (`401`), and deterministic Version 1 canonical JSON / SHA-256 metadata.
   - **Tests 5–11:** Mock minting, independent verification and community activation (`currentOwnerScript` from minted output), rejection of invalid transactions/networks/community IDs/unroutable scripts, duplicate mint prevention, confirmation threshold gating (`UNCONFIRMED` stays `PENDING_MINT`), and blocking `OneSatMintingAdapter` when `APP_MODE="mock"`.
   - **Test 12:** Yours `window.CWI` live 1Sat Ordinal mint flow (`OneSatMintingAdapter` `provider: 'yours'`) parsing a real multi-output `Transaction` (`AtomicBEEF`) where the inscription sits at **non-zero `vout = 2`**, verifying `origin = "${txid}_2"`, actual `rawOutputScriptHex`, and independent `MintVerificationService` activation.
   - **Test 13:** HandCash BRC-100 live mint flow (`OneSatMintingAdapter` `provider: 'handcash'`) exercising both `wallet.createAction` and `wallet.signAction` (`signableTransaction`) and extracting non-zero **`vout = 1`** (`origin = "${txid}_1"`).
   - **Test 14:** Rejection (`MINT_TX_OUTPUT_UNVERIFIABLE`) when a signed transaction lacks a matching 1-satoshi Community NFT inscription output.

## Manual Browser Testing Procedures (Real Wallets on Testnet)

Automated tests use simulated `@bsv/sdk` `ProtoWallet` and mock HTTP substrates. Before enabling production/mainnet, verify real wallets manually on `BSV_NETWORK="test"`:

### A. Preflight Setup (`BSV_NETWORK="test"`)
1. Configure `.env` with valid `DATABASE_URL`, `DIRECT_URL`, 32+ char `SESSION_SECRET`, `BSV_NETWORK="test"`, `OWNERSHIP_CONFIRMATIONS_REQUIRED="1"`, and keep `ALLOW_MAINNET_BROADCAST="false"` (never enable on mainnet unless explicitly authorized).
2. For authentication & UI testing in safe mode: `APP_MODE="mock"`. For live testnet wallet minting: temporarily set `APP_MODE="live"` and `NEXT_PUBLIC_APP_MODE="live"` (`BSV_NETWORK="test"`).
3. Run `npm run dev` and open `http://localhost:3000`.

### B. Manual Checklist — Yours Wallet (`window.CWI` & Legacy `window.yours`)
1. Unlock the Yours Wallet browser extension switched to **Testnet** (with funded testnet satoshis if testing live minting).
2. Click **Re-scan Wallets** in `WalletConnectPanel`. Confirm Yours card shows detected transport (`brc100-cwi` primary, or `legacy-yours` if extension BRC-100 mode is off).
3. Click **Connect Yours Wallet**. Approve the authentication / BRC-100 signature prompt.
4. Confirm:
   - Session card shows `provider: yours`, `network: test`, `identityKey`, and capability badge (`Minting: Enabled` on `window.CWI`, or `Auth-Only` on legacy `window.yours`).
   - Navigate to `/communities/new` and reload the page — confirm session persists cleanly via `AppWalletProvider` (`authenticated` after reload reconnect, or `reauth_required` prompt if wallet is locked).
5. On `window.CWI`, click **Derive & Verify Destination**. Approve key/signature prompt and confirm `payoutScript` updates to a 25-byte P2PKH script (`76a914...88ac`) distinct from `identityKey`.
6. Create a new test community at `/communities/new`. Navigate to `/communities/<slug>`.
7. With `APP_MODE="live"` + `BSV_NETWORK="test"`, click **Authorize & Mint 1Sat Ordinal NFT**:
   - Approve Yours `inscribe` transaction prompt.
   - Verify the UI displays the actual `txid` and extracted `vout` (`<txid>_<vout>`) and transitions cleanly via `/api/communities/[slug]/nft/confirm-mint`.

### C. Manual Checklist — HandCash Desktop BRC Wallet
1. Launch and unlock **HandCash Desktop BRC Wallet** switched to **Testnet** (`127.0.0.1:2121` HTTPS or `127.0.0.1:3321` HTTP bridge active).
2. On `http://localhost:3000`, click **Re-scan Wallets**. Confirm HandCash card shows detected version (`handcash-...`) and `brc100-http`.
   - Optional dual-wallet check: if Yours Wallet is also unlocked, confirm clicking **Connect HandCash** connects **only** to HandCash and never auto-connects to Yours.
3. Approve origin authorization & challenge signature in HandCash Desktop.
4. Confirm `identityKey`, `network: test`, `Live WalletInterface Ready`, and reload persistence (`reauth_required` shown if HandCash Desktop is locked/closed, with working **Reconnect Wallet** button after unlocking).
5. Click **Derive & Verify Destination** and confirm distinct derived BRC-42 `payoutScript` is persisted.
6. On `/communities/<slug>`, with `APP_MODE="live"` + `BSV_NETWORK="test"`, click **Authorize & Mint 1Sat Ordinal NFT** and approve HandCash Desktop's `createAction` / `signAction` prompt; verify actual `txid`, `vout`, `origin`, and independent server verification.

## Subsequent Phase Tests (Phases 4–6)

- **Phase 4:** Ownership indexing, transfer detection, and confirmation threshold gating.
- **Phase 5:** End-to-end multi-output payment intent creation, transaction verification, and security rejection tests.
- **Phase 6:** Full Alice-to-Bob NFT transfer and 70/30 revenue routing switch test.
