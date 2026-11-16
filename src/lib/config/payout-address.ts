import { P2PKH, Utils } from '@bsv/sdk';
import { isStandardP2PKHScript } from '@/lib/ordinals/script-parser';

const MAINNET_P2PKH_VERSION = 0x00;
const TESTNET_P2PKH_VERSION = 0x6f;

export interface VerifiedPayoutDestination {
  address: string;
  publicKeyHashHex: string;
  lockingScriptHex: string;
}

/**
 * Converts a BSV mainnet P2PKH address into its 25-byte locking script and independently
 * verifies the result (checksum, network prefix, length, opcodes, and address round trip).
 * Throws on any failure. Never accepts testnet addresses.
 */
export function deriveVerifiedMainnetPayoutScript(
  address: string
): VerifiedPayoutDestination {
  const trimmed = address.trim();

  let decoded: { prefix: number[]; data: number[] };
  try {
    decoded = Utils.fromBase58Check(trimmed) as { prefix: number[]; data: number[] };
  } catch {
    throw new Error('Payout address is not valid Base58Check (bad characters or checksum).');
  }

  const prefix = decoded.prefix[0];
  if (prefix === TESTNET_P2PKH_VERSION) {
    throw new Error('Payout address is a testnet address; a BSV mainnet address is required.');
  }
  if (decoded.prefix.length !== 1 || prefix !== MAINNET_P2PKH_VERSION) {
    throw new Error('Payout address is not a BSV mainnet P2PKH address (version byte 0x00).');
  }
  if (decoded.data.length !== 20) {
    throw new Error('Payout address does not decode to a 20-byte public key hash.');
  }

  const publicKeyHashHex = Utils.toHex(decoded.data).toLowerCase();
  const lockingScriptHex = `76a914${publicKeyHashHex}88ac`;

  if (
    lockingScriptHex.length !== 50 ||
    !lockingScriptHex.startsWith('76a914') ||
    !lockingScriptHex.endsWith('88ac') ||
    !isStandardP2PKHScript(lockingScriptHex)
  ) {
    throw new Error('Derived locking script is not a standard 25-byte P2PKH script.');
  }

  if (new P2PKH().lock(trimmed).toHex().toLowerCase() !== lockingScriptHex) {
    throw new Error('Derived locking script does not match the SDK P2PKH script.');
  }

  const roundTrip = Utils.toBase58Check(decoded.data, [MAINNET_P2PKH_VERSION]);
  if (roundTrip !== trimmed) {
    throw new Error('Locking script does not convert back to the supplied address.');
  }

  return { address: trimmed, publicKeyHashHex, lockingScriptHex };
}

/**
 * Converts a standard P2PKH locking script back to its BSV mainnet address.
 * Throws for non-standard scripts or incorrect lengths.
 */
export function mainnetAddressFromPayoutScript(scriptHex: string): string {
  const normalized = scriptHex.trim().toLowerCase();
  if (!isStandardP2PKHScript(normalized)) {
    throw new Error('Payout script must be a standard 25-byte P2PKH locking script.');
  }
  return Utils.toBase58Check(Utils.toArray(normalized.slice(6, 46), 'hex'), [
    MAINNET_P2PKH_VERSION,
  ]);
}
