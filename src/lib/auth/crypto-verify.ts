import {
  BigNumber,
  BSM,
  ECDSA,
  Hash,
  ProtoWallet,
  PublicKey,
  Signature,
  Utils,
} from '@bsv/sdk';
import {
  buildP2PKHScriptFromPubKeyHash,
  isStandardP2PKHScript,
} from '@/lib/ordinals/script-parser';
import type {
  SignatureScheme,
  WalletDestinationProof,
  WalletProviderType,
} from '@/types/wallet';

export const AUTH_BRC100_PROTOCOL_ID: [2, string] = [2, 'community nft auth'];
export const DEFAULT_AUTH_KEY_ID = 'auth-challenge';
export const DESTINATION_BRC100_PROTOCOL_ID: [2, string] = [
  2,
  'community nft destination',
];
export const DEFAULT_DESTINATION_KEY_ID = 'destination-0';

const COMPRESSED_PUBKEY_REGEX = /^(02|03)[0-9a-f]{64}$/i;

/**
 * Validates that a string is a 33-byte (66-hex-char) compressed secp256k1 public key.
 */
export function isValidCompressedPublicKey(pubKeyHex: string): boolean {
  const normalized = pubKeyHex.trim().toLowerCase();
  if (!COMPRESSED_PUBKEY_REGEX.test(normalized)) {
    return false;
  }
  try {
    PublicKey.fromString(normalized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives a standard 25-byte P2PKH locking script (`76a914<20-byte-pkh>88ac`)
 * from a compressed 33-byte public key hex string.
 */
export function deriveP2PKHScriptFromPublicKey(pubKeyHex: string): string {
  const normalized = pubKeyHex.trim().toLowerCase();
  if (!isValidCompressedPublicKey(normalized)) {
    throw new Error(
      `Invalid compressed secp256k1 public key: "${pubKeyHex}".`
    );
  }
  const pubKey = PublicKey.fromString(normalized);
  const hashBytes = pubKey.toHash() as number[];
  const pubKeyHashHex = Utils.toHex(hashBytes).toLowerCase();
  return buildP2PKHScriptFromPubKeyHash(pubKeyHashHex);
}

/**
 * Formats the canonical message signed by a wallet to cryptographically prove
 * it can spend/sign for a derived destination P2PKH locking script.
 */
export function formatDestinationOwnershipProofMessage(params: {
  provider: WalletProviderType;
  identityKey: string;
  destinationPublicKey: string;
  lockingScript: string;
  keyID?: string;
}): string {
  return [
    'MicroReddit Destination Ownership Proof',
    `Provider: ${params.provider}`,
    `IdentityKey: ${params.identityKey.trim().toLowerCase()}`,
    `DestinationPublicKey: ${params.destinationPublicKey.trim().toLowerCase()}`,
    `LockingScript: ${params.lockingScript.trim().toLowerCase()}`,
    `KeyID: ${params.keyID ?? DEFAULT_DESTINATION_KEY_ID}`,
  ].join('\n');
}

/**
 * Cryptographically verifies that a claimed P2PKH `payoutScript` is backed by
 * a real destination public key controlled by the wallet and distinct from the root
 * BRC-100 `identityKey`.
 */
export async function verifyDestinationOwnershipProof(params: {
  provider: WalletProviderType;
  identityKey: string;
  payoutScript: string;
  destinationProof?: WalletDestinationProof | null;
}): Promise<{ valid: boolean; reason?: string; derivedScript?: string }> {
  const normalizedPayoutScript = params.payoutScript.trim().toLowerCase();
  const normalizedIdentityKey = params.identityKey.trim().toLowerCase();

  if (!isStandardP2PKHScript(normalizedPayoutScript)) {
    return {
      valid: false,
      reason: 'payoutScript must be a valid 25-byte standard P2PKH locking script.',
    };
  }

  if (!isValidCompressedPublicKey(normalizedIdentityKey)) {
    return {
      valid: false,
      reason: 'Wallet identityKey must be a valid compressed secp256k1 public key.',
    };
  }

  const proof = params.destinationProof;
  if (!proof) {
    return {
      valid: false,
      reason:
        'Cryptographic destination ownership proof is required when supplying a payoutScript.',
    };
  }

  const normalizedDestPubKey = proof.publicKey?.trim().toLowerCase() ?? '';
  if (!isValidCompressedPublicKey(normalizedDestPubKey)) {
    return {
      valid: false,
      reason: 'Destination proof publicKey must be a valid compressed secp256k1 public key.',
    };
  }

  if (normalizedDestPubKey === normalizedIdentityKey) {
    return {
      valid: false,
      reason:
        'Payment destination public key must be derived separately and must not equal the root identityKey.',
    };
  }

  const derivedScript = deriveP2PKHScriptFromPublicKey(normalizedDestPubKey);
  if (
    derivedScript !== normalizedPayoutScript ||
    proof.lockingScript?.trim().toLowerCase() !== derivedScript
  ) {
    return {
      valid: false,
      reason:
        'Destination proof publicKey does not hash to the supplied P2PKH payoutScript.',
    };
  }

  const keyID = proof.keyID ?? DEFAULT_DESTINATION_KEY_ID;
  const expectedMessage = formatDestinationOwnershipProofMessage({
    provider: params.provider,
    identityKey: normalizedIdentityKey,
    destinationPublicKey: normalizedDestPubKey,
    lockingScript: derivedScript,
    keyID,
  });

  if (proof.proofMessage !== expectedMessage) {
    return {
      valid: false,
      reason: 'Destination ownership proof message does not match canonical payload.',
    };
  }

  const scheme: SignatureScheme = proof.signatureScheme ?? 'brc100';
  const msgBytes = Utils.toArray(expectedMessage, 'utf8');

  try {
    if (scheme === 'brc100') {
      const cleanHex = (proof.signature ?? '').trim().toLowerCase();
      if (!cleanHex || !/^[0-9a-f]+$/.test(cleanHex) || cleanHex.length % 2 !== 0) {
        return { valid: false, reason: 'Invalid BRC-100 destination proof signature encoding.' };
      }
      const sigBytes = Utils.toArray(cleanHex, 'hex');
      const sigObj = Signature.fromDER(cleanHex, 'hex');
      const digest = new BigNumber(Hash.sha256(msgBytes));
      const destPubKeyObj = PublicKey.fromString(normalizedDestPubKey);

      const directValid = ECDSA.verify(digest, sigObj, destPubKeyObj);
      if (!directValid) {
        return {
          valid: false,
          reason: 'Destination public key did not sign the ownership proof.',
        };
      }

      if ((proof.counterparty ?? 'anyone') !== 'self') {
        const protocolID = proof.protocolID ?? DESTINATION_BRC100_PROTOCOL_ID;
        const verifier = new ProtoWallet('anyone');
        const expectedDerived = await verifier.getPublicKey({
          protocolID,
          keyID,
          counterparty: normalizedIdentityKey,
        });
        if (expectedDerived.publicKey.toLowerCase() !== normalizedDestPubKey) {
          return {
            valid: false,
            reason:
              'BRC-100 derived destination public key does not match the identity key derivation.',
          };
        }
        const brcResult = await verifier.verifySignature({
          data: msgBytes,
          signature: sigBytes,
          protocolID,
          keyID,
          counterparty: normalizedIdentityKey,
        });
        if (brcResult.valid !== true) {
          return {
            valid: false,
            reason: 'BRC-100 ProtoWallet destination signature verification failed.',
          };
        }
      }

      return { valid: true, derivedScript };
    }

    const valid = await verifyWalletChallengeSignature({
      challenge: expectedMessage,
      signature: proof.signature,
      publicKey: normalizedDestPubKey,
      signatureScheme: scheme,
    });
    return valid
      ? { valid: true, derivedScript }
      : { valid: false, reason: 'Cryptographic destination ownership signature failed.' };
  } catch {
    return {
      valid: false,
      reason: 'Destination ownership proof cryptographic verification threw an error.',
    };
  }
}

/**
 * Extracts the Nonce field from a formatted authentication challenge string.
 */
export function extractNonceFromChallenge(challenge: string): string | null {
  const match = /^Nonce:\s*([0-9a-fA-F-]{16,128})$/m.exec(challenge);
  return match?.[1] ?? null;
}

/**
 * Verifies a cryptographic wallet signature over a challenge message.
 *
 * Supports:
 * 1. `brc100` — BRC-100 `WalletInterface.createSignature` (BRC-42/43 derived key with
 *    `protocolID: [2, 'community nft auth']`, `counterparty: 'anyone'`), verified via
 *    `@bsv/sdk` `ProtoWallet('anyone').verifySignature`.
 * 2. `bsm` — Bitcoin Signed Message (`window.yours.signMessage`), verified via `@bsv/sdk` `BSM.verify`.
 * 3. `ecdsa-sha256` — Direct DER ECDSA signature over SHA-256(challenge), verified via `@bsv/sdk` `ECDSA.verify`.
 */
export async function verifyWalletChallengeSignature(params: {
  challenge: string;
  signature: string;
  publicKey: string;
  keyID?: string;
  signatureScheme?: SignatureScheme;
}): Promise<boolean> {
  const { challenge, signature, publicKey } = params;
  const normalizedPubKey = publicKey.trim().toLowerCase();

  if (!challenge || !signature || !isValidCompressedPublicKey(normalizedPubKey)) {
    return false;
  }

  const scheme: SignatureScheme = params.signatureScheme ?? 'brc100';
  const messageBytes = Utils.toArray(challenge, 'utf8');
  const resolvedKeyId =
    params.keyID ?? extractNonceFromChallenge(challenge) ?? DEFAULT_AUTH_KEY_ID;

  try {
    if (scheme === 'brc100') {
      const cleanHex = signature.trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(cleanHex) || cleanHex.length % 2 !== 0) {
        return false;
      }
      const signatureBytes = Utils.toArray(cleanHex, 'hex');
      const verifier = new ProtoWallet('anyone');
      const result = await verifier.verifySignature({
        data: messageBytes,
        signature: signatureBytes,
        protocolID: AUTH_BRC100_PROTOCOL_ID,
        keyID: resolvedKeyId,
        counterparty: normalizedPubKey,
      });
      return result.valid === true;
    }

    const pubKeyObj = PublicKey.fromString(normalizedPubKey);

    if (scheme === 'bsm') {
      let sigObj: Signature;
      const trimmedSig = signature.trim();
      if (/^[0-9a-f]+$/i.test(trimmedSig) && trimmedSig.length % 2 === 0) {
        sigObj = Signature.fromDER(trimmedSig, 'hex');
      } else {
        sigObj = Signature.fromCompact(trimmedSig, 'base64');
      }
      return BSM.verify(messageBytes, sigObj, pubKeyObj);
    }

    if (scheme === 'ecdsa-sha256') {
      const cleanHex = signature.trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(cleanHex) || cleanHex.length % 2 !== 0) {
        return false;
      }
      const sigObj = Signature.fromDER(cleanHex, 'hex');
      const digest = Hash.sha256(messageBytes);
      return ECDSA.verify(new BigNumber(digest), sigObj, pubKeyObj);
    }

    return false;
  } catch {
    return false;
  }
}
