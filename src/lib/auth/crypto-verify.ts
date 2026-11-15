import {
  BigNumber,
  BSM,
  ECDSA,
  Hash,
  ProtoWallet,
  PublicKey,
  Signature,
} from '@bsv/sdk';
import { buildP2PKHScriptFromPubKeyHash } from '@/lib/ordinals/script-parser';
import type { SignatureScheme } from '@/types/wallet';

export const AUTH_BRC100_PROTOCOL_ID: [2, string] = [2, 'community nft auth'];
export const DEFAULT_AUTH_KEY_ID = 'auth-challenge';

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
  const pubKeyHashHex = Buffer.from(hashBytes).toString('hex').toLowerCase();
  return buildP2PKHScriptFromPubKeyHash(pubKeyHashHex);
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
  const messageBytes = Array.from(Buffer.from(challenge, 'utf8'));
  const resolvedKeyId =
    params.keyID ?? extractNonceFromChallenge(challenge) ?? DEFAULT_AUTH_KEY_ID;

  try {
    if (scheme === 'brc100') {
      const cleanHex = signature.trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(cleanHex) || cleanHex.length % 2 !== 0) {
        return false;
      }
      const signatureBytes = Array.from(Buffer.from(cleanHex, 'hex'));
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
