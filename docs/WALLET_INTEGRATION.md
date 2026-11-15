# Wallet Integration Guide (`docs/WALLET_INTEGRATION.md`)

## 1. Shared BRC-100 `WalletAdapter` Architecture

All wallet integrations implement `WalletAdapter` in `src/adapters/wallets/wallet-adapter.ts` using shared helpers in `src/adapters/wallets/brc100-shared.ts`:

```ts
export interface WalletAdapter {
  readonly provider: WalletProviderType; // 'yours' | 'handcash' | 'mock'
  isAvailable(): Promise<boolean>;
  connect(): Promise<WalletConnectionResult>;
  disconnect(): Promise<void>;
  getIdentity(): Promise<WalletIdentity>;
  getCapabilities(): WalletCapabilities;
  getWalletInterface(): WalletInterface | null;
  deriveDestination(options?: { keyID?: string }): Promise<VerifiedWalletDestination>;
  signChallenge(challenge: string): Promise<SignatureResult>;
  sendOutputs(outputs: PaymentOutput[]): Promise<TransactionResult>;
  mintOrdinal(input: MintOrdinalInput): Promise<MintResult>;
  getNetwork(): Promise<'main' | 'test'>;
}
```

Shared BRC-100 behavior in `src/adapters/wallets/brc100-shared.ts`:
- `normalizeBsvNetwork`: maps `'mainnet' | 'main'` → `'main'` and `'testnet' | 'test'` → `'test'`.
- `normalizeBrc100WalletError`: classifies user rejections (`USER_REJECTED`), locked/unauthenticated state (`WALLET_LOCKED`), mismatched providers (`PROVIDER_MISMATCH`), unauthorized origins, and unreachable bridges (`NETWORK_ERROR` / `WALLET_NOT_FOUND`).
- `deriveAndSignBrc100Destination`: derives a distinct BRC-42 child payment key via `wallet.getPublicKey({ protocolID: [2, 'community nft destination'], keyID: 'destination-0', counterparty: 'anyone', forSelf: true })` and signs a canonical `MicroReddit Destination Ownership Proof` message via `wallet.createSignature(...)`.

## 2. Explicit Provider Selection & `@1sat/react` Tradeoff

- `@bsv/sdk`'s `new WalletClient('auto')` and `@1sat/connect`'s `connectWallet()` race all substrates (`window.CWI`, `https://localhost:2121`, `http://localhost:3301`, `XDM`) and pick whichever responds first.
- Consequently, `@1sat/react`'s built-in `WalletProvider` / `useWallet` hooks **cannot be used** as the connection layer when both Yours and HandCash are installed because they delegate to `@1sat/connect`.
- Instead, the application wraps its root layout (`src/app/layout.tsx`) with `AppWalletProvider` (`src/context/wallet-context.tsx`, accessed via `useAppWallet()`):
  - Calls `discoverAvailableWallets` and `createExplicitWalletAdapter(provider)` in `src/adapters/wallets/provider-registry.ts` with no `'auto'` mode.
  - Each adapter checks `getVersion()` and throws `WalletConnectionError('PROVIDER_MISMATCH', ...)` if the wrong vendor responds.
  - Preserves the live `WalletAdapter` and BRC-100 `WalletInterface` across Next.js client navigation, stores only the non-secret provider ID in `sessionStorage` (`micro_reddit_selected_wallet_provider`), and attempts explicit wallet reconnection on page reload when a server cookie session is active (prompting with `reauth_required` if the wallet is locked or closed).

## 3. Provider Comparison: Yours Wallet vs. HandCash vs. Mock

| Capability | Yours Wallet (`YoursWalletAdapter`) | HandCash Desktop BRC Wallet (`HandCashWalletAdapter`) | Mock (`MockWalletAdapter`) |
|---|---|---|---|
| **Primary Transport** | BRC-100 `window.CWI` (`new WalletClient('window.CWI', originator)`). Legacy `window.yours` is kept as **auth-only fallback** (`canMintOrdinal: false`). | BRC-100 Desktop HTTP bridge probing `https://127.0.0.1:2121` (primary) and `http://127.0.0.1:3321` (fallback) via `new WalletClient(new HTTPWalletJSON(originator, endpoint), originator)`. | Deterministic offline `@bsv/sdk` `ProtoWallet` (enabled only when `APP_MODE="mock"`). |
| **Vendor Check (`getVersion`)** | Accepts `yours*`, `1sat*`, `babbage*`, or `cwi*`; explicitly rejects `handcash*` (`PROVIDER_MISMATCH`). | Strictly requires `handcash*` prefix; rejects non-HandCash bridges (`PROVIDER_MISMATCH`). | `mock-1.0.0`. |
| **Challenge Signing** | BRC-100 `createSignature` (`[2, 'community nft auth']`, `brc100`), or legacy `window.yours.signMessage` (`bsm`). | BRC-100 `createSignature` (`[2, 'community nft auth']`, `brc100`). | BRC-100 `ProtoWallet.createSignature` (`brc100`). |
| **Destination Derivation (`deriveDestination`)** | Supported via BRC-100 `window.CWI` (`deriveAndSignBrc100Destination`); throws `UnsupportedWalletOperationError` on legacy `window.yours`. | Supported via BRC-100 HTTP bridge (`deriveAndSignBrc100Destination`). | Supported via `ProtoWallet` (`deriveAndSignBrc100Destination`). |
| **1Sat Ordinal Minting (`mintOrdinal`)** | Supported on `window.CWI` via `OneSatMintingAdapter` (`@1sat/actions` `createContext` + `inscribe.execute`, `canMintOrdinal: true`). Legacy `window.yours` throws `UnsupportedWalletOperationError`. | Supported via `OneSatMintingAdapter` (`wallet.createAction` + optional `wallet.signAction` using `@1sat/templates` `buildInscriptionScript` wrapped in 1-satoshi output, `canMintOrdinal: true`). | Simulated via `MockMintingAdapter` in `MockChainTransactionStore` when `APP_MODE="mock"`. |
| **Multi-Output Payments (`sendOutputs`)** | Phase 5 (throws `UnsupportedWalletOperationError` in Phase 3). | Phase 5 (throws `UnsupportedWalletOperationError` in Phase 3). | Phase 5 (throws `UnsupportedWalletOperationError` in Phase 3). |

### HandCash Mobile Limitation
- HandCash **Desktop BRC Wallet** runs a local BRC-100 JSON-API bridge on `https://127.0.0.1:2121` / `http://127.0.0.1:3321`, enabling full `waitForAuthentication`, `getPublicKey`, `createSignature`, `createAction`, and `signAction` support.
- HandCash **Mobile** alone does not run a localhost BRC-100 HTTP bridge for desktop browsers and therefore cannot participate in live BRC-100 challenge signing or transaction building without HandCash Desktop or an explicit BRC-100 substrate.

## 4. Cryptographic Destination Verification & Authoritative Ownership

1. **No Identity-Key Payout Derivation:** The server never derives a P2PKH `payoutScript` from a BRC-100 root `identityKey`.
2. **Cryptographic `destinationProof` Required:** Any client request setting or updating `payoutScript` (`POST /api/auth/verify`, `POST /api/wallets/connect`, `POST /api/wallets/destination`) must include a `destinationProof` verified by `verifyDestinationOwnershipProof` (`src/lib/auth/crypto-verify.ts`):
   - `destinationProof.publicKey` must be a valid compressed secp256k1 key **distinct from** the wallet's `identityKey`.
   - `deriveP2PKHScriptFromPublicKey(destinationProof.publicKey)` must equal `lockingScript` / `payoutScript`.
   - Signature over `formatDestinationOwnershipProofMessage(...)` must verify cryptographically against the wallet's BRC-100 key derivation (`ProtoWallet('anyone')` or ECDSA).
3. **Live Mint Output Extraction (`OneSatMintingAdapter`):** After minting via Yours or HandCash in `APP_MODE="live"` (blocked on mainnet unless `ALLOW_MAINNET_MINT=true`; `BSV_NETWORK="test"` recommended), `OneSatMintingAdapter` parses the signed transaction bytes (`AtomicBEEF`, multi-tx `Beef`, raw tx bytes, lookup provider, or `OneSatServices`), locates the actual `1`-satoshi output matching the canonical Community NFT inscription and verified `ownerP2PKHScript`, extracts the **actual `vout` index** (never hardcoded `0`) and **actual `rawOutputScriptHex`**, and submits `{ action: 'verify-tx', txid, vout, expectedOrigin }` to `/api/communities/[slug]/nft/confirm-mint`.
4. **Authoritative Community Ownership:** Only after `MintVerificationService` independently verifies the minted transaction on-chain (and confirmation count `>= OWNERSHIP_CONFIRMATIONS_REQUIRED`) does `Community.currentOwnerScript` become the verified locking script and `Community.status` transition to `ACTIVE`.

## 5. Security Architecture

1. **Zero Secret Key Exposure:** No adapter, API route, or browser storage ever requests, stores, or transmits private keys or seed phrases.
2. **Single-Use Domain & Session-Bound Challenges:** Challenges embed `Domain`, `Provider`, `Nonce`, `IssuedAt`, `ExpiresAt`, and optional `SessionBinding`, expire in 5 minutes, and are consumed atomically in PostgreSQL (`CHALLENGE_REUSED` on replay).
3. **HttpOnly Signed Sessions:** Server sessions use `HttpOnly`, `SameSite=Lax`, `Path=/` cookies (`poc_session`) backed by `auth_sessions` in PostgreSQL.
4. **Unauthorized Cross-Account Wallet Linking Prevention:** Claiming a `(provider, identityKey)` already verified on another user account returns `409 Conflict` (`UNAUTHORIZED_WALLET_LINK`) and writes an `UNAUTHORIZED_WALLET_LINK_BLOCKED` audit record.
