# Wallet Integration Guide (`docs/WALLET_INTEGRATION.md`)

## 1. Normalized `WalletAdapter` Interface

All wallet integrations implement `WalletAdapter` in `src/adapters/wallets/wallet-adapter.ts`:

```ts
export interface WalletAdapter {
  readonly provider: WalletProviderType; // 'yours' | 'handcash' | 'mock'
  isAvailable(): Promise<boolean>;
  connect(): Promise<WalletConnectionResult>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getIdentity(): Promise<WalletIdentity>;
  signChallenge(challenge: string): Promise<SignatureResult>;
  sendOutputs(outputs: PaymentOutput[]): Promise<TransactionResult>;
  mintOrdinal(input: MintOrdinalInput): Promise<MintResult>;
}
```

## 2. Explicit Provider Selection (No Auto-Detection Racing)

- `@bsv/sdk`'s `new WalletClient('auto')` and `@1sat/connect`'s `connectWallet({ autoDetect: true })` race all BRC-100 substrates (`window.CWI`, `https://localhost:2121`, `http://localhost:3301`, `XDM`) and pick whichever wallet responds first.
- **Architectural Rule:** We **never** call `WalletClient('auto')` when connecting a provider. Instead, the user must explicitly choose **Yours Wallet**, **HandCash**, or **Mock Wallet** via `createExplicitWalletAdapter(provider)` in `src/adapters/wallets/provider-registry.ts`.
- Each adapter verifies the underlying wallet vendor version string (`getVersion()`) and throws `WalletConnectionError('PROVIDER_MISMATCH', ...)` if the responding substrate belongs to a different wallet vendor.

## 3. Provider Comparison: Yours Wallet vs. HandCash vs. Mock

| Capability | Yours Wallet (`YoursWalletAdapter`) | HandCash (`HandCashWalletAdapter`) | Mock (`MockWalletAdapter`) |
|---|---|---|---|
| **Discovery** | Inspects `window.CWI` (BRC-100 injected substrate) and `window.yours` (injected browser extension). | Inspects injected HandCash client or BRC-100 desktop/mobile JSON-API (`https://localhost:2121`, `http://localhost:3301`) and `XDM` iframe substrate. | Always available in `APP_MODE="mock"`. |
| **Explicit Connection** | Calls `waitForAuthentication()` + `getVersion()` (verifies `yours-*` / `1sat-*` / `babbage-*` / `cwi-*` prefix) on `window.CWI`, or `window.yours.connect()` on extension. | Probes `secure-json-api`, `json-api`, and `XDM` in order; calls `waitForAuthentication()` + `getVersion()` and verifies `handcash*` prefix. | Deterministically derives secp256k1 `PrivateKey` + `@bsv/sdk` `ProtoWallet`. |
| **Identity Retrieval** | Retrieves compressed 33-byte `identityKey` (`getPublicKey({ identityKey: true })` or `window.yours.getPubKeys().identityPubKey`). Only derives a P2PKH `payoutScript` on the `window.yours` extension path when `pubKeys.bsvPubKey` (the dedicated BSV payment public key) is explicitly returned; on BRC-100 (`window.CWI`), `payoutScript` is `null` because `identityKey` is not assumed to be the payment key. | Retrieves compressed 33-byte `identityKey` via BRC-100 `getPublicKey({ identityKey: true })`. `payoutScript` is `null` unless a verified payment destination is explicitly provided (`identityKey` is never used to derive a payout script). | Retrieves compressed 33-byte `identityKey` from `ProtoWallet` and derives deterministic mock P2PKH locking script. |
| **Challenge Signing** | - **BRC-100 (`window.CWI`):** `createSignature({ data, protocolID: [2, 'community nft auth'], keyID: <nonce>, counterparty: 'anyone' })` (`signatureScheme: 'brc100'`).<br>- **Extension (`window.yours`):** `signMessage({ message, encoding: 'utf8' })` (`signatureScheme: 'bsm'`). | **BRC-100:** `createSignature({ data, protocolID: [2, 'community nft auth'], keyID: <nonce>, counterparty: 'anyone' })` (`signatureScheme: 'brc100'`). | **BRC-100:** `ProtoWallet.createSignature({ data, protocolID: [2, 'community nft auth'], keyID: <nonce>, counterparty: 'anyone' })` (`signatureScheme: 'brc100'`). |
| **Backend Signature Verification** | Verified in `src/lib/auth/crypto-verify.ts` via `ProtoWallet('anyone').verifySignature(...)` for `brc100` or `@bsv/sdk` `BSM.verify(...)` for `bsm`. Server enforces its configured `BSV_NETWORK` and never derives `currentPayoutScript` from `identityKey`. | Verified in `src/lib/auth/crypto-verify.ts` via `ProtoWallet('anyone').verifySignature(...)` (`brc100`) or raw `ECDSA.verify(...)` (`ecdsa-sha256`). Server enforces its configured `BSV_NETWORK` and never derives `currentPayoutScript` from `identityKey`. | Verified in `src/lib/auth/crypto-verify.ts` via `ProtoWallet('anyone').verifySignature(...)` (`brc100`). |
| **`sendOutputs` (Phase 3 Status)** | Throws `UnsupportedWalletOperationError` in Phase 3 (implemented in Phase 5). | Throws `UnsupportedWalletOperationError` in Phase 3 (implemented in Phase 5). | Throws `UnsupportedWalletOperationError` in Phase 3 (implemented in Phase 5). |
| **`mintOrdinal` (Phase 3 Status)** | Supported via `OneSatMintingAdapter` (`@1sat/actions` `inscribe.execute`) when connected via BRC-100 (`window.CWI`) in `APP_MODE="live"`. Throws `UnsupportedWalletOperationError` on legacy `window.yours` extension without BRC-100 `WalletInterface`. | Throws `UnsupportedWalletOperationError` unless a funded BRC-100 inscription substrate is available; external transaction verification via `POST /api/communities/[slug]/nft/confirm-mint` is supported. | Implemented via `MockMintingAdapter`, constructing a genuine 1Sat Ordinal inscription script in `MockChainTransactionStore`. |

## 4. Security Architecture

1. **Zero Secret Key Exposure:** No adapter ever requests, accepts, or stores seed phrases or private keys.
2. **Cryptographic Challenge Verification:** Wallet addresses or public keys are never trusted on claim alone. Every login and wallet-linking action requires signing a server-generated challenge.
3. **Domain, Provider, and Session Binding:** Each challenge embeds `Domain`, `Provider`, `Nonce`, `IssuedAt`, `ExpiresAt`, and optional `SessionBinding`.
4. **Single-Use & Expiration Enforcement:** Challenges expire after 5 minutes (`DEFAULT_CHALLENGE_TTL_MS`) and are marked `usedAt` immediately upon verification (`CHALLENGE_REUSED` on replay).
5. **HttpOnly Signed Sessions:** Server sessions use `HttpOnly`, `SameSite=Lax`, `Path=/` cookies (`poc_session`) signed with HMAC-SHA256 (`SESSION_SECRET`).
6. **Unauthorized Cross-Account Wallet Linking Prevention:** If User B attempts to link a `(provider, identityKey)` wallet that is already verified and linked to User A, `WalletAuthService` blocks the operation with HTTP `409 Conflict` (`UNAUTHORIZED_WALLET_LINK`) and records an `UNAUTHORIZED_WALLET_LINK_BLOCKED` audit event.
