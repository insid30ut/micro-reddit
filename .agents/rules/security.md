# Security Rules

1. **Never Store Secrets:** Never store or log private keys, WIFs, mnemonic seed phrases, or wallet secrets in configuration, database tables, or client storage.
2. **Never Trust Client Inputs:** Validate all API inputs with Zod. Never trust client-supplied payout scripts, fee splits, ownership claims, or confirmation statuses.
3. **Mock Mode Default:** Default `APP_MODE` and `NEXT_PUBLIC_APP_MODE` to `"mock"`. Never broadcast mainnet transactions, mint live NFTs, or spend real BSV without explicit user approval.
4. **Confirmation-Gated Authorization:** An `OBSERVED` (0-confirmation/mempool) payment or ownership transfer must never authorize a `PaidActivity` or switch active revenue routing until the configured confirmation threshold (`PAYMENT_CONFIRMATIONS_REQUIRED` / `OWNERSHIP_CONFIRMATIONS_REQUIRED`) is satisfied.
5. **Idempotency & Replay Prevention:** Enforce unique transaction IDs (`Payment.transactionId`), single-payment-per-intent (`Payment.paymentIntentId`), and single-use expiring authentication challenges.
