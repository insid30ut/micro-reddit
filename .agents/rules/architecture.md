# Architecture Rules

1. **Source of Truth:** Follow `docs/POC_BLUEPRINT.md` and `AGENTS.md` strictly. Do not implement out-of-scope features (feeds, comments, voting, marketplace, auctions).
2. **Modular Wallets:** Keep all wallet-provider-specific code isolated inside `src/adapters/wallets/`. Application services must interact only with `WalletAdapter`.
3. **Blockchain Separation:** Keep blockchain indexing and transaction parsing inside `src/adapters/blockchain/` and `src/lib/ordinals/`.
4. **On-Chain Ownership Authority:** The current owner of a community NFT is identified by the verified on-chain locking script (`currentOwnerScript`) of the ordinal's unspent output. Linking to a registered `WalletConnection` (`currentOwnerWalletConnectionId`) is optional.
5. **PaymentIntent Ownership Snapshot:** Each `PaymentIntent` captures an immutable snapshot of `ownerOutpointSnapshot` and `ownerPayoutScript` at creation time (valid for its short expiration window). Subsequent ownership transfers apply to newly created `PaymentIntent` records.
