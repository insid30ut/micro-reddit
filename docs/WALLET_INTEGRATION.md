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
| **Identity Retrieval** | Retrieves compressed 33-byte `identityKey` (`getPublicKey({ identityKey: true })` or `window.yours.getPubKeys().identityPubKey`) and derives standard P2PKH locking script (`76a914...88ac`). | Retrieves compressed 33-byte `identityKey` via BRC-100 `getPublicKey({ identityKey: true })` and derives standard P2PKH locking script (`76a914...88ac`). | Retrieves compressed 33-byte `identityKey` from `ProtoWallet` and derives standard P2PKH locking script. |
| **Challenge Signing** | - **BRC-100 (`window.CWI`):** `createSignature({ data, protocolID: [2, 'community nft auth'], keyID: <nonce>, counterparty: 'anyone' })` (`signatureScheme: 'brc100'`).<br>- **Extension (`window.yours`):** `signMessage({ message, encoding: 'utf8' })` (`signatureScheme: 'bsm'`). | **BRC-100:** `createSignature({ data, protocolID: [2, 'community nft auth'], keyID: <nonce>, counterparty: 'anyone' })` (`signatureScheme: 'brc100'`). | **BRC-100:** `ProtoWallet.createSignature({ data, protocolID: [2, 'community nft auth'], keyID: <nonce>, counterparty: 'anyone' })` (`signatureScheme: 'brc100'`). |
| **Backend Signature Verification** | Verified in `src/lib/auth/crypto-verify.ts` via `ProtoWallet('anyone').verifySignature(...)` for `brc100` or `@bsv/sdk` `BSM.verify(...)` for `bsm`. | Verified in `src/lib/auth/crypto-verify.ts` via `ProtoWallet('anyone').verifySignature(...)` (`brc100`) or raw `ECDSA.verify(...)` (`ecdsa-sha256`). | Verified in `src/lib/auth/crypto-verify.ts` via `ProtoWallet('anyone').verifySignature(...)` (`brc100`). |
| **`sendOutputs` (Phase 2 Status)** | Throws `UnsupportedWalletOperationError` in Phase 2 (implemented in Phase 5). | Throws `UnsupportedWalletOperationError` in Phase 2 (implemented in Phase 5). | Throws `UnsupportedWalletOperationError` in Phase 2 (implemented in Phase 5). |
| **`mintOrdinal` (Phase 2 Status)** | Throws `UnsupportedWalletOperationError` in Phase 2 (implemented in Phase 3). | Throws `UnsupportedWalletOperationError` in Phase 2 (implemented in Phase 3). | Throws `UnsupportedWalletOperationError` in Phase 2 (implemented in Phase 3). |

## 4. Security Architecture

1. **Zero Secret Key Exposure:** No adapter ever requests, accepts, or stores seed phrases or private keys.
2. **Cryptographic Challenge Verification:** Wallet addresses or public keys are never trusted on claim alone. Every login and wallet-linking action requires signing a server-generated challenge.
3. **Domain, Provider, and Session Binding:** Each challenge embeds `Domain`, `Provider`, `Nonce`, `IssuedAt`, `ExpiresAt`, and optional `SessionBinding`.
4. **Single-Use & Expiration Enforcement:** Challenges expire after 5 minutes (`DEFAULT_CHALLENGE_TTL_MS`) and are marked `usedAt` immediately upon verification (`CHALLENGE_REUSED` on replay).
5. **HttpOnly Signed Sessions:** Server sessions use `HttpOnly`, `SameSite=Lax`, `Path=/` cookies (`poc_session`) signed with HMAC-SHA256 (`SESSION_SECRET`).
6. **Unauthorized Cross-Account Wallet Linking Prevention:** If User B attempts to link a `(provider, identityKey)` wallet that is already verified and linked to User A, `WalletAuthService` blocks the operation with HTTP `409 Conflict` (`UNAUTHORIZED_WALLET_LINK`) and records an `UNAUTHORIZED_WALLET_LINK_BLOCKED` audit event.
