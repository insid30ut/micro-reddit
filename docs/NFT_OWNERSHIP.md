# 1Sat Ordinal NFT Ownership & Script Parsing Specification

## 1. Permanent Identity vs. Current Outpoint

- Every community is represented by a single 1Sat Ordinal NFT identified permanently by its genesis origin outpoint:
  `<origin_txid>_<origin_vout>` (stored in `CommunityNFT.origin`, `originTxid`, `originVout`).
- As the NFT is transferred between wallets, its `origin` never changes, while its current unspent outpoint (`<currentTxid>_<currentVout>`) updates with each spend.

## 2. On-Chain Locking Script as Owner Identity

- The current owner of a community NFT is identified by the **verified on-chain locking script** (`currentOwnerScript`) of the ordinal's current unspent output.
- Linking `currentOwnerScript` to a registered platform user (`Community.currentOwnerWalletConnectionId`) is **optional**. An external user who receives a community NFT in Yours Wallet, HandCash, or another BSV wallet without ever creating a platform account still receives 70% of paid activity fees directly to their on-chain P2PKH locking script.

## 3. Protocol-Aware 1Sat Ordinals Script Parser

A 1Sat Ordinal output locking script typically combines:
1. An inscription envelope: `OP_FALSE OP_IF "ord" OP_1 <contentType> OP_0 <content> OP_ENDIF` (which may appear before or after the spending condition).
2. Optional trailing metadata: `OP_RETURN ...` (such as MAP protocol key-value pairs or Sigma signatures).
3. The actual **spending condition** (locking script) that governs who can spend the 1-satoshi output.

### Extraction & Validation Rules (`src/lib/ordinals/script-parser.ts`)

1. Parse the raw output script into opcode chunks using `@bsv/sdk` `Script`.
2. Strip any `OP_FALSE OP_IF ... OP_ENDIF` (`00 63 ... 68`) inscription envelope blocks.
3. Strip any trailing `OP_RETURN` (`6a`) data segments (or `OP_CODESEPARATOR` prefixes where applicable).
4. Inspect the remaining spending condition opcodes:
   - **Standard P2PKH (`76 a9 14 <20-byte-pubKeyHash> 88 ac`):**
     - `OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG`
     - Extracted `lockingScriptHex` is the clean 25-byte hex string (`50` hex characters).
     - Marked `scriptType = "P2PKH"`, `isPayoutRoutable = true`.
   - **Non-Standard / Smart Contract (e.g., OrdLock marketplace listing, multisig, custom script):**
     - Marked `scriptType = "NON_STANDARD"` (or `"ORDLOCK"`), `isPayoutRoutable = false`.
     - Community status is updated to `PAYOUT_UNAVAILABLE`. The platform **never** guesses a payout address and **never** falls back to paying the historical creator.

## 4. Confirmation Policy for Ownership Transfers

- Mempool (`0`-conf) ordinal transfers are recorded as `UNCONFIRMED` `OwnershipEvent` entries for visibility but **do not** change the active `currentOwnerScript` used for revenue routing until `confirmations >= OWNERSHIP_CONFIRMATIONS_REQUIRED`.
