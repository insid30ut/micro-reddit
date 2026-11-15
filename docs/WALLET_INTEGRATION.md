# Wallet Integration Guide

## 1. Unified `WalletAdapter` Abstraction

All wallet interactions pass through the provider-agnostic `WalletAdapter` interface (`src/adapters/wallets/wallet-adapter.ts`):

- `provider`: `"yours" | "handcash" | "mock"`
- `connect(): Promise<WalletConnectionResult>`
- `disconnect(): Promise<void>`
- `getIdentity(): Promise<WalletIdentity>`
- `signChallenge(challenge: string): Promise<SignatureResult>`
- `sendOutputs(outputs: PaymentOutput[]): Promise<TransactionResult>`
- `mintOrdinal(metadata: OrdinalMetadata): Promise<MintResult>`
- `getNetwork(): Promise<string>`

## 2. Supported Wallet Providers (Phase 2+)

### Yours Wallet (`provider = "yours"`)
- Uses `@1sat/connect` (`connectWallet`) and `@bsv/sdk` BRC-100 `WalletInterface`.
- Supports challenge signing (`createSignature` / BRC-77 `signRequest`), multi-output payments (`createAction`), and 1Sat Ordinal inscriptions (`@1sat/actions` `inscribe`).

### HandCash BRC-100 Wallet (`provider = "handcash"`)
- Targets the self-custodial HandCash BRC-100 wallet via `@bsv/sdk` `WalletClient`.
- Does **not** require `HANDCASH_APP_ID` or `HANDCASH_APP_SECRET` (which belong to the separate cloud HandCash Connect OAuth SDK).
- If any operation (such as 1-satoshi `"ord"` inscription minting) is rejected by the wallet's policy, the adapter surfaces a typed `UnsupportedWalletOperationError` rather than silently substituting a mock or single-output transaction.

### Mock Wallet (`provider = "mock"`)
- Active by default when `APP_MODE="mock"`.
- Uses deterministic test keys from `@bsv/sdk` `PrivateKey` to sign challenges and construct realistic mock transactions without broadcasting to the BSV mainnet.
