import { PublicKey, Utils, type WalletInterface } from '@bsv/sdk';
import { WalletConnectionError } from '@/adapters/wallets/wallet-adapter';
import {
  DEFAULT_DESTINATION_KEY_ID,
  DESTINATION_BRC100_PROTOCOL_ID,
  deriveP2PKHScriptFromPublicKey,
  formatDestinationOwnershipProofMessage,
  isValidCompressedPublicKey,
  verifyDestinationOwnershipProof,
} from '@/lib/auth/crypto-verify';
import type {
  VerifiedWalletDestination,
  WalletProviderType,
} from '@/types/wallet';

/**
 * Normalizes a BRC-100 `getNetwork()` response into `'main' | 'test'`.
 */
export function normalizeBsvNetwork(raw: unknown): 'main' | 'test' {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'testnet' || value === 'test' ? 'test' : 'main';
}

/**
 * Shared BRC-100 error normalizer translating wallet transport, lock, rejection,
 * and origin-authorization errors into actionable `WalletConnectionError`s.
 */
export function normalizeBrc100WalletError(
  provider: WalletProviderType,
  err: unknown,
  bridgeLabel?: string
): WalletConnectionError {
  if (err instanceof WalletConnectionError) {
    return err;
  }

  const rawMessage =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message?: unknown }).message ?? 'Unknown wallet error')
        : 'Unknown wallet error';
  const lower = rawMessage.toLowerCase();

  if (
    lower.includes('reject') ||
    lower.includes('denied') ||
    lower.includes('cancel') ||
    lower.includes('declined')
  ) {
    return new WalletConnectionError(
      provider,
      'USER_REJECTED',
      `${provider === 'handcash' ? 'HandCash' : 'Yours Wallet'} request was rejected by the user (${rawMessage}).`
    );
  }

  if (lower.includes('lock') || lower.includes('unauthenticated')) {
    return new WalletConnectionError(
      provider,
      'WALLET_LOCKED',
      `${provider === 'handcash' ? 'HandCash Desktop BRC Wallet' : 'Yours Wallet'} is locked. Unlock your wallet and retry.`
    );
  }

  if (
    lower.includes('unauthorized') ||
    lower.includes('origin') ||
    lower.includes('permission') ||
    lower.includes('401') ||
    lower.includes('403')
  ) {
    return new WalletConnectionError(
      provider,
      'USER_REJECTED',
      `Origin permission denied by ${provider === 'handcash' ? 'HandCash Desktop BRC Wallet' : 'Yours Wallet'}: ${rawMessage}`
    );
  }

  if (
    lower.includes('fetch') ||
    lower.includes('econnrefused') ||
    lower.includes('networkerror') ||
    lower.includes('failed to fetch') ||
    lower.includes('timed out') ||
    lower.includes('not found') ||
    lower.includes('no wallet') ||
    lower.includes('no brc-100')
  ) {
    const hint =
      bridgeLabel ??
      (provider === 'handcash'
        ? 'HandCash Desktop BRC-100 bridge was not reachable at https://127.0.0.1:2121 or http://127.0.0.1:3321.'
        : 'Yours Wallet extension / window.CWI was not detected.');
    return new WalletConnectionError(
      provider,
      'WALLET_NOT_FOUND',
      `${hint} (${rawMessage})`
    );
  }

  return new WalletConnectionError(provider, 'AUTHENTICATION_FAILED', rawMessage);
}

/**
 * Derives a protocol-scoped child public key via BRC-42/43 (`forSelf: true`),
 * computes its 25-byte P2PKH locking script, signs an ownership proof via
 * `createSignature`, and cryptographically verifies the proof before returning it.
 */
export async function deriveAndSignBrc100Destination(params: {
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;
  provider: WalletProviderType;
  identityKey: string;
  network?: 'main' | 'test';
  keyID?: string;
}): Promise<VerifiedWalletDestination> {
  const normalizedIdentityKey = params.identityKey.trim().toLowerCase();
  if (!isValidCompressedPublicKey(normalizedIdentityKey)) {
    throw new WalletConnectionError(
      params.provider,
      'INVALID_DESTINATION_PROOF',
      'Cannot derive wallet destination without a valid identityKey.'
    );
  }

  const keyID = params.keyID ?? DEFAULT_DESTINATION_KEY_ID;
  const protocolID = DESTINATION_BRC100_PROTOCOL_ID;

  const { publicKey } = await params.wallet.getPublicKey({
    protocolID,
    keyID,
    counterparty: 'anyone',
    forSelf: true,
  });

  const destPubKey = publicKey.trim().toLowerCase();
  if (!isValidCompressedPublicKey(destPubKey)) {
    throw new WalletConnectionError(
      params.provider,
      'INVALID_DESTINATION_PROOF',
      'Wallet returned an invalid compressed destination public key.'
    );
  }
  if (destPubKey === normalizedIdentityKey) {
    throw new WalletConnectionError(
      params.provider,
      'INVALID_DESTINATION_PROOF',
      'Derived destination key must differ from the root identityKey.'
    );
  }

  const lockingScript = deriveP2PKHScriptFromPublicKey(destPubKey);
  const address = PublicKey.fromString(destPubKey).toAddress(
    params.network === 'test' ? 'testnet' : 'mainnet'
  );
  const proofMessage = formatDestinationOwnershipProofMessage({
    provider: params.provider,
    identityKey: normalizedIdentityKey,
    destinationPublicKey: destPubKey,
    lockingScript,
    keyID,
  });

  const { signature } = await params.wallet.createSignature({
    data: Utils.toArray(proofMessage, 'utf8'),
    protocolID,
    keyID,
    counterparty: 'anyone',
  });

  const signatureHex = Utils.toHex(Array.from(signature)).toLowerCase();

  const destinationProof: VerifiedWalletDestination = {
    publicKey: destPubKey,
    lockingScript,
    address,
    signature: signatureHex,
    signatureScheme: 'brc100',
    proofMessage,
    protocolID,
    keyID,
    counterparty: 'anyone',
  };

  const verification = await verifyDestinationOwnershipProof({
    provider: params.provider,
    identityKey: normalizedIdentityKey,
    payoutScript: lockingScript,
    destinationProof,
  });

  if (!verification.valid) {
    throw new WalletConnectionError(
      params.provider,
      'INVALID_DESTINATION_PROOF',
      verification.reason ??
        'Wallet destination ownership proof failed client-side verification.'
    );
  }

  return destinationProof;
}
