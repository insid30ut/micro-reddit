# Blockchain & 1Sat Ordinals Rules

1. **Permanent NFT Identity:** Always identify a community NFT by its genesis origin outpoint `<origin_txid>_<origin_vout>`, never by its mutable current transfer transaction ID.
2. **Protocol-Aware Script Parsing:** Never copy a raw 1Sat Ordinal output script (`OP_FALSE OP_IF "ord" ... OP_ENDIF`) as a payment destination. Always parse the script with `@bsv/sdk` `Script`, strip the ordinal inscription envelope and any `OP_RETURN` metadata, and verify that the remaining spending condition is a standard 25-byte P2PKH script (`76a914<20-byte-pkh>88ac`).
3. **Non-Standard Script Handling:** If an ordinal is locked by a non-P2PKH script (e.g., OrdLock listing or custom contract), mark `isPayoutRoutable = false` and set community status to `PAYOUT_UNAVAILABLE`. Never guess a payout address or fall back to the historical creator.
4. **Atomic Multi-Output Payments:** Paid activities require a single BSV transaction containing both the 70% owner output and the 30% platform output, independently verified from raw transaction bytes on the backend.
